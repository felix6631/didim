import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { attachmentDownloadUrl, createCase, getLatestAssessment, getMessages, listAttachments, listCases, removeAttachment, removeCase, streamChat, uploadAttachment } from "./api";
import type { Assessment, Attachment, CaseItem, Message, RiskLevel } from "./types";

const riskLabel: Record<RiskLevel, string> = { low: "낮음", caution: "주의", danger: "위험", emergency: "긴급" };
const initialAssessment: Assessment = { level: "low", score: 0, category: "분석 전", rationale: "상황을 입력하면 위험도와 대응 절차를 정리합니다.", actions: [], based_law: [] };

function renderText(text: string) { return text.split("\n").map((line, i) => <span key={i}>{line.replaceAll("**", "")}<br /></span>); }
function formatBytes(size: number) { return size < 1024 ? `${size}B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)}KB` : `${(size / 1024 / 1024).toFixed(1)}MB`; }
function formatDate(iso: string) { try { return new Date(iso).toLocaleString("ko-KR"); } catch { return iso; } }

export default function App() {
  const [cases, setCases] = useState<CaseItem[]>([]), [selected, setSelected] = useState<number | null>(null), [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(""), [assessment, setAssessment] = useState<Assessment>(initialAssessment), [loading, setLoading] = useState(false), [aside, setAside] = useState(true), [error, setError] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]), [uploading, setUploading] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const thread = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const active = cases.find(c => c.id === selected);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  function toggleVoiceInput() {
    const SpeechRecognitionAPI =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      setError(
        "이 브라우저에서는 음성 입력을 지원하지 않습니다. Chrome 또는 Edge를 사용해 주세요."
      );
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const recognition = new SpeechRecognitionAPI();

    recognition.lang = "ko-KR";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setIsListening(true);
      setError("");
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = "";

      for (
        let i = event.resultIndex;
        i < event.results.length;
        i++
      ) {
        const transcript = event.results[i][0].transcript;

        if (event.results[i].isFinal) {
          finalText += transcript;
        }
      }

      if (finalText.trim()) {
        setInput((prev) => {
          const separator = prev.trim() ? " " : "";
          return prev + separator + finalText.trim();
        });
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setIsListening(false);

      if (event.error === "not-allowed") {
        setError(
          "마이크 권한이 필요합니다. 브라우저에서 마이크 사용을 허용해 주세요."
        );
      } else {
        setError(`음성 인식 오류: ${event.error}`);
      }
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }

  async function loadAttachments(id: number) { try { setAttachments(await listAttachments(id)); } catch { setAttachments([]); } }
  async function loadAssessment(id: number, fallback?: CaseItem) {
    const latest = await getLatestAssessment(id);
    if (latest) { setAssessment({ level: latest.risk_level as RiskLevel, score: latest.risk_score, category: latest.category, rationale: latest.rationale, actions: latest.actions, based_law: latest.based_law }); }
    else if (fallback) { setAssessment({ ...initialAssessment, level: fallback.risk_level, score: fallback.risk_score, category: fallback.category, based_law: fallback.based_law }); }
    else { setAssessment(initialAssessment); }
  }

  async function refresh(prefer?: number) { const all = await listCases(); setCases(all); const id = prefer ?? selected ?? all[0]?.id; if (id) { setSelected(id); setMessages(await getMessages(id)); await loadAssessment(id, all.find(x => x.id === id)); await loadAttachments(id); } }
  useEffect(() => { refresh().catch(() => setError("백엔드에 연결할 수 없습니다. start.bat을 실행했는지 확인하세요.")); }, []);
  useEffect(() => { thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" }); }, [messages]);

  async function addCase() { const c = await createCase(); setAssessment(initialAssessment); setAttachments([]); await refresh(c.id); setRailOpen(false); }
  async function choose(id: number) { setSelected(id); setMessages(await getMessages(id)); await loadAssessment(id, cases.find(x => x.id === id)); await loadAttachments(id); setRailOpen(false); }
  async function del() { if (!selected || !confirm("이 상담 기록을 삭제할까요?")) return; await removeCase(selected); setSelected(null); setMessages([]); setAttachments([]); await refresh(); }
  async function send(e?: FormEvent, forcedContent?: string) {
    e?.preventDefault();

    const content = (forcedContent ?? input).trim();

    if (!content || loading) return;

    let id = selected;

    if (!id) {
      const c = await createCase();
      id = c.id;
      setSelected(id);
    }

    setInput("");
    setError("");
    setLoading(true);

    setMessages(m => [
      ...m,
      {
        case_id: id!,
        role: "user",
        content
      },
      {
        case_id: id!,
        role: "assistant",
        content: ""
      }
    ]);

    try {
      const result = await streamChat(
        id,
        content,
        t =>
          setMessages(m =>
            m.map((x, i) =>
              i === m.length - 1
                ? { ...x, content: x.content + t }
                : x
            )
          )
      );

      setAssessment(result);
      await refresh(id);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "오류가 발생했습니다."
      );

      setMessages(m => m.slice(0, -1));
    } finally {
      setLoading(false);
    }
  }
  async function onDeleteAttachment(attachmentId: number) {
    if (!selected) return;
    await removeAttachment(selected, attachmentId);
    await loadAttachments(selected);
  }

  return <main className="app-shell">
    <header className="titlebar"><span className="logo-sm" />디딤 — 교권 침해 상담 도우미<span className="title-space" /><span className="status">LOCAL</span></header>
    <div className={`layout ${aside ? "" : "aside-closed"}`}>
      {railOpen && <div className="rail-backdrop show" onClick={() => setRailOpen(false)} />}
      <nav className={`rail ${railOpen ? "open" : ""}`}><div className="brand"><div className="logo">디</div><div><b>디딤</b><small>교권 침해 상담</small></div></div><button className="new" onClick={addCase}>＋ 새 상담 시작</button><div className="rail-label">최근 상담</div><div className="case-list">{cases.map(c => <button className={`case ${selected === c.id ? "active" : ""}`} onClick={() => choose(c.id)} key={c.id}><i className={c.risk_level} /><span><b>{c.title}</b><small>{c.category} · {c.risk_score}점</small></span></button>)}</div><div className="privacy">🔒 상담 내용은 이 컴퓨터에 저장됩니다.</div></nav>
      <section className="chat"><div className="chat-head"><button className="menu-btn" aria-label="상담 목록" onClick={() => setRailOpen(x => !x)}>☰</button><div><h1>{active?.title ?? "새 상담"}</h1><small>{active ? `사건 #${String(active.id).padStart(4, "0")}` : "상담을 시작하세요"}</small></div><span /><button onClick={() => setAside(x => !x)}>{aside ? "결과 접기" : "결과 보기"}</button><button onClick={del} disabled={!selected}>삭제</button><button onClick={exportPrint}>내보내기</button></div>
        <div className="thread" ref={thread}>{messages.length === 0 && <div className="empty"><div className="empty-logo">디</div><h2>혼자 감당하지 않아도 됩니다</h2><p>새 상담을 시작하고 상황을 시간 순서대로 적어 주세요.<br />학생·학부모의 실명과 연락처는 입력하지 마세요.</p></div>}{messages.map((m, i) => <article className={`message ${m.role}`} key={m.id ?? i}><div className="avatar">{m.role === "assistant" ? "디" : "나"}</div><div className="bubble">{renderText(m.content || "답변을 정리하고 있습니다…")}</div></article>)}</div>
        {error && <div className="error">{error}</div>}<form className="composer" onSubmit={send}>
  

          <div className="input">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={
                isListening
                  ? "말씀해 주세요…"
                  : "상황을 자세히 적어 주세요…"
              }
              maxLength={8000}
            />

            <div className="input-actions">
              <button
                type="button"
                className={`voice-btn ${isListening ? "listening" : ""}`}
                onClick={toggleVoiceInput}
                disabled={loading}
                aria-label={
                  isListening
                    ? "음성 입력 중지"
                    : "음성 입력 시작"
                }
                title={
                  isListening
                    ? "음성 입력 중지"
                    : "음성으로 입력"
                }
              >
                {isListening ? (
                  <span className="listening-icon">■</span>
                ) : (
                  <img
                    src="/mic.png"
                    alt="음성 입력"
                    className="mic-image"
                  />
                )}
              </button>

              <button
                type="submit"
                disabled={
                  loading ||
                  input.trim().length < 2
                }
              >
                {loading ? "…" : "➜"}
              </button>
            </div>
          </div>

          <small>
            일반적인 안내 도구이며 구체적인 판단은 교원단체·법률 전문가의 검토가 필요합니다.
          </small>
        </form>

        {active && <section className="report-print">
          <header className="report-head"><h1>교권 침해 상담 사건 보고서</h1><p>Case Report for Teacher-Rights Infringement Consultation</p></header>
          <table className="report-meta">
            <tbody>
              <tr><th>사건 번호</th><td>#{String(active.id).padStart(4, "0")}</td><th>작성일</th><td>{formatDate(active.created_at)}</td></tr>
              <tr><th>상담 제목</th><td>{active.title}</td><th>최종 수정일</th><td>{formatDate(active.updated_at)}</td></tr>
              <tr><th>사건 분류</th><td>{assessment.category}</td><th>위험도</th><td>{riskLabel[assessment.level]} ({assessment.score} / 100)</td></tr>
            </tbody>
          </table>
          <section className="report-section"><h2>평가 근거</h2><p>{assessment.rationale}</p></section>
          <section className="report-section"><h2>근거 법령</h2>{assessment.based_law.length ? <ul>{assessment.based_law.map(x => <li key={x}>{x}</li>)}</ul> : <p className="report-muted">확인된 근거 법령이 없습니다.</p>}</section>
          <section className="report-section"><h2>권장 대응 조치</h2>{assessment.actions.length ? <ol>{assessment.actions.map(x => <li key={x}>{x}</li>)}</ol> : <p className="report-muted">권장 조치가 없습니다.</p>}</section>
          <section className="report-section"><h2>상담 기록</h2>{messages.map((m, i) => <div className="report-msg" key={m.id ?? i}><b>{m.role === "assistant" ? "디딤" : "상담자"}</b><span>{m.content}</span></div>)}</section>
          <section className="report-section"><h2>첨부 증거 자료</h2>{attachments.length ? <ul>{attachments.map(a => <li key={a.id}>{a.filename} ({formatBytes(a.size)}, {formatDate(a.created_at)})</li>)}</ul> : <p className="report-muted">첨부된 파일이 없습니다.</p>}</section>
          <footer className="report-footer">
            <p>본 보고서는 입력된 상담 내용을 바탕으로 자동 생성된 참고 자료이며, 법률적·행정적 최종 판단이 아닙니다.<br />정확한 처리를 위해 학교 관리자 및 교원단체·법률 전문가의 검토를 받으시기 바랍니다.</p>
            <div className="report-signature"><div><span>작성자 확인</span><i /></div><div><span>관리자 확인</span><i /></div></div>
          </footer>

        </section>}
      </section>
    </div>
  </main>;
}
