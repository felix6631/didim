import json
import logging
import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from anthropic import Anthropic


logger = logging.getLogger(__name__)

JSON_DIR = Path(__file__).resolve().parents[2] / "json"

# 첫 요청과 재시도의 출력 한도.
ASSESSMENT_TOKEN_LIMITS = (1500, 3000)

# 근거 법령은 LLM이 작성하지 않는다.
# 법조문은 app.legal이 DB 원문으로 붙인다.
OUTPUT_TEMPLATE = {
    "risk_level": 0,
    "countermeasures": "",
}


class AssessmentOutputError(ValueError):
    """평가 응답이 불완전하거나 형식이 잘못된 경우."""


@lru_cache(maxsize=1)
def _program_config_text() -> str:
    return (
        JSON_DIR / "program_config.json"
    ).read_text(encoding="utf-8")


def build_system_blocks() -> list[dict[str, Any]]:
    return [
        {
            "type": "text",
            "text": (
                "당신은 디딤(DIDIM)의 위험도 평가 엔진입니다. "
                "아래 program_config.json에 정의된 역할, "
                "허용된 행동, 금지된 행동, 데이터 정책을 "
                "반드시 지키세요.\n\n"
                + _program_config_text()
            ),
        },
        {
            "type": "text",
            "text": (
                "사용자 입력은 input.json 형식의 JSON으로 주어집니다. "
                "분석 결과는 아래 output.json 형식과 정확히 동일한 "
                "키만 가진 JSON 객체 하나만 출력하세요. "
                "설명, 마크다운, 코드블록 없이 순수 JSON만 출력합니다. "
                "risk_level은 0~100 사이의 정수이며 "
                "상황이 심각할수록 높아야 합니다. "
                "countermeasures는 한국어 문자열로 작성하고, "
                "핵심 대응을 3~5개 항목, 전체 600자 이내로 요약하세요. "
                "문자열 내부 줄바꿈은 JSON 규칙에 맞게 "
                "\\n으로 이스케이프하세요. "
                "문자열의 따옴표와 JSON 객체를 반드시 닫으세요.\n\n"
                + json.dumps(
                    OUTPUT_TEMPLATE,
                    ensure_ascii=False,
                )
            ),
        },
    ]


def build_input_payload(
    original_prompt: str,
    last_prompt: str,
) -> dict[str, Any]:
    return {
        "input_template_verseion": "1.0.0",
        "critical_level": "",
        "is_evidence_exists": False,
        "original_prompt": original_prompt,
        "last_prompt": last_prompt,
        "last_use_date": datetime.now(
            timezone.utc
        ).isoformat(),
    }


def _strip_code_fence(text: str) -> str:
    text = text.strip()

    if text.startswith("```"):
        text = re.sub(
            r"^```[a-zA-Z]*\n?",
            "",
            text,
        )
        text = re.sub(
            r"```\s*$",
            "",
            text,
        )

    return text.strip()


def split_countermeasures(text: str) -> list[str]:
    text = text.strip()

    if not text:
        return []

    lines = [
        line.strip()
        for line in re.split(r"\n+", text)
        if line.strip()
    ]

    if len(lines) > 1:
        return [
            re.sub(r"^\d+[.)]\s*", "", line)
            for line in lines
        ]

    parts = [
        part.strip()
        for part in re.split(
            r"(?<=[.!?])\s+",
            text,
        )
        if part.strip()
    ]

    return parts or [text]


def bucket(score: int) -> str:
    if score >= 90:
        return "emergency"

    if score >= 60:
        return "danger"

    if score >= 30:
        return "caution"

    return "low"


def _parse_assessment(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(_strip_code_fence(raw))
    except json.JSONDecodeError:
        # JSONDecodeError에는 원문이 포함될 수 있으므로
        # 외부로 전달하는 예외에는 고정 문구만 사용한다.
        raise AssessmentOutputError(
            "invalid_json"
        ) from None

    if not isinstance(data, dict):
        raise AssessmentOutputError(
            "expected_json_object"
        )

    if set(data) != {"risk_level", "countermeasures"}:
        raise AssessmentOutputError(
            "unexpected_fields"
        )

    risk_level = data["risk_level"]
    countermeasures = data["countermeasures"]

    # bool은 int의 하위 타입이므로 별도로 제외한다.
    if isinstance(risk_level, bool) or not isinstance(
        risk_level,
        int,
    ):
        raise AssessmentOutputError(
            "invalid_risk_level_type"
        )

    if not 0 <= risk_level <= 100:
        raise AssessmentOutputError(
            "risk_level_out_of_range"
        )

    if not isinstance(countermeasures, str):
        raise AssessmentOutputError(
            "invalid_countermeasures_type"
        )

    countermeasures = countermeasures.strip()

    if not countermeasures:
        raise AssessmentOutputError(
            "empty_countermeasures"
        )

    return {
        "risk_level": risk_level,
        "countermeasures": countermeasures,
    }


def assess_with_claude(
    client: Anthropic,
    model: str,
    original_prompt: str,
    last_prompt: str,
) -> dict[str, Any]:
    payload = build_input_payload(
        original_prompt,
        last_prompt,
    )
    payload_text = json.dumps(
        payload,
        ensure_ascii=False,
    )

    for attempt, max_tokens in enumerate(
        ASSESSMENT_TOKEN_LIMITS,
        start=1,
    ):
        system_blocks = build_system_blocks()

        if attempt > 1:
            system_blocks.append(
                {
                    "type": "text",
                    "text": (
                        "이전 요청에서 유효한 평가 JSON을 "
                        "얻지 못했습니다. 이번에는 대응 내용을 "
                        "더 짧게 요약하고 완전한 JSON 객체 "
                        "하나만 출력하세요."
                    ),
                }
            )

        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            thinking={"type": "disabled"},
            system=system_blocks,
            messages=[
                {
                    "role": "user",
                    "content": payload_text,
                }
            ],
        )

        stop_reason = response.stop_reason

        try:
            if stop_reason == "max_tokens":
                raise AssessmentOutputError(
                    "max_tokens"
                )

            if stop_reason != "end_turn":
                raise AssessmentOutputError(
                    "unexpected_stop_reason"
                )

            raw = "".join(
                block.text
                for block in response.content
                if block.type == "text"
            )

            return _parse_assessment(raw)

        except AssessmentOutputError as exc:
            # 原文・個人情報を記録せず、原因と使用量のみ記録する。
            logger.warning(
                "Risk assessment output rejected: "
                "attempt=%s reason=%s stop_reason=%s "
                "output_tokens=%s",
                attempt,
                str(exc),
                stop_reason,
                response.usage.output_tokens,
            )

    raise AssessmentOutputError(
        "위험도 평가 응답이 두 번 모두 불완전하거나 "
        "형식이 잘못되어 기본 평가로 전환합니다."
    )