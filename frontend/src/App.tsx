import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import {
  attachmentDownloadUrl,
  createCase,
  getLatestAssessment,
  getMessages,
  listAttachments,
  listCases,
  removeAttachment,
  removeCase,
  streamChat,
  uploadAttachment
} from "./api";
import type { Assessment, Attachment, CaseItem, Message, RiskLevel } from "./types";

const riskLabel: Record<RiskLevel, string> = { low: "낮음", caution: "주의", danger: "위험", emergency: "긴급" };
const initialAssessment: Assessment = {
  level: "low",
  score: 0,
  category: "분석 전",
  rationale: "상황을 입력하면 위험도와 대응 절차를 정리합니다.",
  actions: [],
  based_law: []
};

const emptyTitles = [
  "혼자 감당하지 않아도 됩니다",
  "무슨 생각을 하시나요?",
  "지금 겪고 있는 일을 들려주세요",
  "편하게 말씀해 주세요",
  "필요한 도움을 함께 찾아볼게요"
];

const TEXTAREA_MIN = 46;
const TEXTAREA_MAX = 92;

function getRandomEmptyTitle() {
  return emptyTitles[Math.floor(Math.random() * emptyTitles.length)];
}

function renderInlineText(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`)/g);

  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    if (part.startsWith("~~") && part.endsWith("~~")) return <del key={index}>{part.slice(2, -2)}</del>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

function renderText(text: string) {
  return text.split("\n").map((line, i) => (
    <span key={i}>
      {renderInlineText(line)}
      <br />
    </span>
  ));
}

function formatBytes(size: number) {
  return size < 1024
    ? `${size}B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)}KB`
      : `${(size / 1024 / 1024).toFixed(1)}MB`;
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString("ko-KR");
  } catch {
    return iso;
  }
}

function exportPrint() {
  window.print();
}

export default function App() {
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [assessment, setAssessment] = useState<Assessment>(initialAssessment);
  const [loading, setLoading] = useState(false);
  const [aside, setAside] = useState(true);
  const [error, setError] = useState("");
  const [inputExpanded, setInputExpanded] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [emptyTitle, setEmptyTitle] = useState(getRandomEmptyTitle);
  const [isListening, setIsListening] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [showNewAnswer, setShowNewAnswer] = useState(false);
  const [responseTime, setResponseTime] = useState<number | null>(null);
  const [bookmarks, setBookmarks] = useState<number[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("didim-bookmarks") || "[]");
    } catch {
      return [];
    }
  });

  const thread = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const active = cases.find(c => c.id === selected);
  const isGreetingOnly = messages.length === 1 && messages[0].role === "assistant";
  const visibleMessages = isGreetingOnly ? [] : messages;

  // ---------- 북마크 ----------
  useEffect(() => {
    try {
      localStorage.setItem("didim-bookmarks", JSON.stringify(bookmarks));
    } catch {
      /* 저장소를 쓸 수 없는 환경은 무시 */
    }
  }, [bookmarks]);

  function toggleBookmark(messageId: number) {
    setBookmarks(prev => (prev.includes(messageId) ? prev.filter(id => id !== messageId) : [...prev, messageId]));
  }

  // ---------- 복사 ----------
  async function copyAnswer(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setError("AI 답변이 복사되었습니다.");
      setTimeout(() => setError(""), 1500);
    } catch {
      setError("답변을 복사하지 못했습니다.");
    }
  }

  // ---------- 음성 입력 ----------
  function toggleVoiceInput() {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      setError("이 브라우저에서는 음성 입력을 지원하지 않습니다. Chrome 또는 Edge를 사용해 주세요.");
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
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
      }
      if (finalText.trim()) {
        setInput(prev => prev + (prev.trim() ? " " : "") + finalText.trim());
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setIsListening(false);
      if (event.error === "not-allowed") {
        setError("마이크 권한이 필요합니다. 브라우저에서 마이크 사용을 허용해 주세요.");
      } else {
        setError(`음성 인식 오류: ${event.error}`);
      }
    };

    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
  }

  // ---------- 입력창 자동 높이 ----------
  // 타이핑·음성 입력·전송 후 비우기 모두 input이 바뀌므로 여기서 한 번에 처리
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = `${TEXTAREA_MIN}px`;
    const nextHeight = Math.min(el.scrollHeight, TEXTAREA_MAX);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > TEXTAREA_MAX ? "auto" : "hidden";
    setInputExpanded(nextHeight > TEXTAREA_MIN);
  }, [input]);

  // ---------- 데이터 로딩 ----------
  async function loadAttachments(id: number) {
    try {
      setAttachments(await listAttachments(id));
    } catch {
      setAttachments([]);
    }
  }

  async function loadAssessment(id: number, fallback?: CaseItem) {
    const latest = await getLatestAssessment(id);
    if (latest) {
      setAssessment({
        level: latest.risk_level as RiskLevel,
        score: latest.risk_score,
        category: latest.category,
        rationale: latest.rationale,
        actions: latest.actions,
        based_law: latest.based_law
      });
    } else if (fallback) {
      setAssessment({
        ...initialAssessment,
        level: fallback.risk_level,
        score: fallback.risk_score,
        category: fallback.category,
        based_law: fallback.based_law
      });
    } else {
      setAssessment(initialAssessment);
    }
  }

  async function refresh(prefer?: number) {
    const all = await listCases();
    setCases(all);
    const id = prefer ?? selected ?? all[0]?.id;
    if (id) {
      setSelected(id);
      setMessages(await getMessages(id));
      await loadAssessment(id, all.find(x => x.id === id));
      await loadAttachments(id);
    }
  }

  useEffect(() => {
    refresh().catch(() => setError("백엔드에 연결할 수 없습니다. start.bat을 실행했는지 확인하세요."));
  }, []);

  // ---------- 스크롤 ----------
  function scrollToBottom() {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" });
    setShowNewAnswer(false);
  }

  useEffect(() => {
    const el = thread.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) scrollToBottom();
    else setShowNewAnswer(true);
  }, [messages]);

  // ---------- 상담 ----------
  async function addCase() {
    const c = await createCase();
    setEmptyTitle(current => {
      const candidates = emptyTitles.filter(title => title !== current);
      return candidates[Math.floor(Math.random() * candidates.length)];
    });
    setAssessment(initialAssessment);
    setAttachments([]);
    setResponseTime(null);
    await refresh(c.id);
    setRailOpen(false);
  }

  async function choose(id: number) {
    setSelected(id);
    setMessages(await getMessages(id));
    await loadAssessment(id, cases.find(x => x.id === id));
    await loadAttachments(id);
    setResponseTime(null);
    setRailOpen(false);
  }

  async function del() {
    if (!selected || !confirm("이 상담 기록을 삭제할까요?")) return;
    await removeCase(selected);
    setSelected(null);
    setMessages([]);
    setAttachments([]);
    await refresh();
  }

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
    const startTime = performance.now();
    setLoading(true);

    setMessages(m => [
      ...m,
      { case_id: id!, role: "user", content },
      { case_id: id!, role: "assistant", content: "" }
    ]);

    try {
      const result = await streamChat(id, content, t =>
        setMessages(m => m.map((x, i) => (i === m.length - 1 ? { ...x, content: x.content + t } : x)))
      );
      setAssessment(result);
      setResponseTime(Number(((performance.now() - startTime) / 1000).toFixed(1)));
      await refresh(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "오류가 발생했습니다.");
      setMessages(m => m.slice(0, -1));
    } finally {
      setLoading(false);
    }
  }

  // ---------- 첨부 ----------
  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    let id = selected;
    if (!id) {
      const c = await createCase();
      id = c.id;
      setSelected(id);
      await refresh(id);
    }

    setUploading(true);
    setError("");
    try {
      await uploadAttachment(id!, file);
      await loadAttachments(id!);
    } catch (err) {
      setError(err instanceof Error ? err.message : "파일 업로드에 실패했습니다.");
    } finally {
      setUploading(false);
    }
  }

  async function onDeleteAttachment(attachmentId: number) {
    if (!selected) return;
    await removeAttachment(selected, attachmentId);
    await loadAttachments(selected);
  }

  // ---------- 렌더 ----------
  return (
    <main className="app-shell">
      <header className="titlebar">
        <img className="logo-sm" src="/icons/icon.svg" alt="디딤" />
        디딤 — 교권 침해 상담 도우미
        <span className="title-space" />
        <span className="status">LOCAL</span>
      </header>

      <div className={`layout ${aside ? "" : "aside-closed"} ${darkMode ? "dark-mode" : ""}`}>
        {railOpen && <div className="rail-backdrop show" onClick={() => setRailOpen(false)} />}

        <nav className={`rail ${railOpen ? "open" : ""}`}>
          <div className="brand">
            <div className="logo">
              <img src="/icons/icon.svg" alt="디딤" />
            </div>
            <div>
              <b>디딤</b>
              <small>교권 침해 상담</small>
            </div>
          </div>
          <button className="new" onClick={addCase}>＋ 새 상담 시작</button>
          <div className="rail-label">최근 상담</div>
          <div className="case-list">
            {cases.map(c => (
              <button className={`case ${selected === c.id ? "active" : ""}`} onClick={() => choose(c.id)} key={c.id}>
                <i className={c.risk_level} />
                <span>
                  <b>{c.title}</b>
                  <small>{c.category} · {c.risk_score}점</small>
                </span>
              </button>
            ))}
          </div>
          <div className="privacy">🔒 상담 내용은 이 컴퓨터에 저장됩니다.</div>
        </nav>

        <section className="chat">
          <div className="chat-head">
            <button className="menu-btn" aria-label="상담 목록" onClick={() => setRailOpen(x => !x)}>☰</button>
            <div>
              <h1>{active?.title ?? "새 상담"}</h1>
              <small>{active ? `사건 #${String(active.id).padStart(4, "0")}` : "상담을 시작하세요"}</small>
            </div>
            <span />
            <button onClick={() => setAside(x => !x)}>{aside ? "결과 접기" : "결과 보기"}</button>
            <button type="button" onClick={() => setDarkMode(x => !x)} title={darkMode ? "라이트 모드" : "다크 모드"}>
              {darkMode ? "☀️" : "🌙"}
            </button>
            <button onClick={del} disabled={!selected}>삭제</button>
            <button onClick={exportPrint}>내보내기</button>
          </div>

          <div className="thread" ref={thread}>
            {showNewAnswer && (
              <button type="button" className="new-answer-btn" onClick={scrollToBottom}>↓ 새 답변</button>
            )}

            {visibleMessages.length === 0 && (
              <div className="empty">
                <div className="empty-logo"><img src="/icons/icon.svg" alt="디딤" /></div>
                <h2>{emptyTitle}</h2>
                <p>
                  새 상담을 시작하고 상황을 편하게 적어 주세요.<br />
                  학생·학부모의 실명과 연락처는 입력하지 마세요.
                </p>
              </div>
            )}

            {visibleMessages.map((m, i) => (
              <article className={`message ${m.role}`} key={m.id ?? i}>
                <div className="avatar">
                  {m.role === "assistant" ? <img src="/icons/icon.svg" alt="디딤" /> : "나"}
                </div>
                <div className="bubble">
                  {renderText(m.content || "답변을 정리하고 있습니다…")}

                  {m.role === "assistant" && m.content && !loading && (
                    <div className="message-actions">
                      {responseTime !== null && i === visibleMessages.length - 1 && (
                        <span className="response-time">답변 완료 · {responseTime.toFixed(1)}초</span>
                      )}
                      <button type="button" className="copy-btn" onClick={() => copyAnswer(m.content)}>
                        📋 복사
                      </button>
                      {m.id != null && (
                        <button
                          type="button"
                          className={`bookmark-btn ${bookmarks.includes(m.id) ? "on" : ""}`}
                          onClick={() => toggleBookmark(m.id!)}
                          title={bookmarks.includes(m.id) ? "북마크 해제" : "북마크"}
                        >
                          {bookmarks.includes(m.id) ? "★" : "☆"} 북마크
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>

          {error && <div className="error">{error}</div>}

          {/* 첨부 입력은 하나만 두고 composer·aside 버튼이 같이 사용 */}
          <input ref={fileInput} type="file" className="file-hidden" onChange={onUpload} />

          <form className="composer" onSubmit={send}>
            <div className={`input ${inputExpanded ? "expanded" : ""}`}>
              <button
                type="button"
                className="attach-btn"
                aria-label="첨부자료 추가"
                title="첨부자료 추가"
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
              >
                +
              </button>

              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={isListening ? "말씀해 주세요…" : "상황을 자세히 적어 주세요…"}
                maxLength={8000}
              />

              <div className="input-actions">
                <button
                  type="button"
                  className={`voice-btn ${isListening ? "listening" : ""}`}
                  onClick={toggleVoiceInput}
                  disabled={loading}
                  aria-label={isListening ? "음성 입력 중지" : "음성 입력 시작"}
                  title={isListening ? "음성 입력 중지" : "음성으로 입력"}
                >
                  {isListening ? (
                    <span className="listening-icon">■</span>
                  ) : (
                    <img src="/mic.png" alt="음성 입력" className="mic-image" />
                  )}
                </button>

                <button type="submit" className="send-btn" disabled={loading || input.trim().length < 2}>
                  {loading ? "…" : "➜"}
                </button>
              </div>
            </div>
            <small>일반적인 안내 도구이며 구체적인 판단은 교원단체·법률 전문가의 검토가 필요합니다.</small>
          </form>

          {active && (
            <section className="report-print">
              <header className="report-head">
                <h1>교권 침해 상담 사건 보고서</h1>
                <p>Case Report for Teacher-Rights Infringement Consultation</p>
              </header>
              <table className="report-meta">
                <tbody>
                  <tr>
                    <th>사건 번호</th><td>#{String(active.id).padStart(4, "0")}</td>
                    <th>작성일</th><td>{formatDate(active.created_at)}</td>
                  </tr>
                  <tr>
                    <th>상담 제목</th><td>{active.title}</td>
                    <th>최종 수정일</th><td>{formatDate(active.updated_at)}</td>
                  </tr>
                  <tr>
                    <th>사건 분류</th><td>{assessment.category}</td>
                    <th>위험도</th><td>{riskLabel[assessment.level]} ({assessment.score} / 100)</td>
                  </tr>
                </tbody>
              </table>
              <section className="report-section">
                <h2>평가 근거</h2>
                <p>{assessment.rationale}</p>
              </section>
              <section className="report-section">
                <h2>근거 법령</h2>
                {assessment.based_law.length ? (
                  <ul>{assessment.based_law.map(x => <li key={x}>{x}</li>)}</ul>
                ) : (
                  <p className="report-muted">확인된 근거 법령이 없습니다.</p>
                )}
              </section>
              <section className="report-section">
                <h2>권장 대응 조치</h2>
                {assessment.actions.length ? (
                  <ol>{assessment.actions.map(x => <li key={x}>{x}</li>)}</ol>
                ) : (
                  <p className="report-muted">권장 조치가 없습니다.</p>
                )}
              </section>
              <section className="report-section">
                <h2>상담 기록</h2>
                {visibleMessages.map((m, i) => (
                  <div className="report-msg" key={m.id ?? i}>
                    <b>{m.role === "assistant" ? "디딤" : "상담자"}</b>
                    <span>{m.content}</span>
                  </div>
                ))}
              </section>
              <section className="report-section">
                <h2>첨부 증거 자료</h2>
                {attachments.length ? (
                  <ul>
                    {attachments.map(a => (
                      <li key={a.id}>{a.filename} ({formatBytes(a.size)}, {formatDate(a.created_at)})</li>
                    ))}
                  </ul>
                ) : (
                  <p className="report-muted">첨부된 파일이 없습니다.</p>
                )}
              </section>
              <footer className="report-footer">
                <p>
                  본 보고서는 입력된 상담 내용을 바탕으로 자동 생성된 참고 자료이며, 법률적·행정적 최종 판단이 아닙니다.<br />
                  정확한 처리를 위해 학교 관리자 및 교원단체·법률 전문가의 검토를 받으시기 바랍니다.
                </p>
                <div className="report-signature">
                  <div><span>작성자 확인</span><i /></div>
                  <div><span>관리자 확인</span><i /></div>
                </div>
              </footer>
            </section>
          )}
        </section>

        {aside && (
          <aside className="aside">
            <div className="aside-head">
              <div>
                <h2>상담 결과</h2>
                <small>입력 내용 기반 임시 분석</small>
              </div>
              <button onClick={() => setAside(false)}>›</button>
            </div>
            <div className="aside-scroll">
              <div className="meta"><span>분류</span><b>{assessment.category}</b></div>

              <section className={`risk ${assessment.level}`}>
                <label>위험도</label>
                <div className="risk-card">
                  <div>
                    <strong>{riskLabel[assessment.level]}</strong>
                    <b>{assessment.score} / 100</b>
                  </div>
                  <div className="gauge"><i style={{ width: `${assessment.score}%` }} /></div>
                  <p>{assessment.rationale}</p>
                </div>
              </section>

              <section className="result">
                <label>대응 권고</label>
                <div>
                  {assessment.actions.length ? (
                    <ol>{assessment.actions.map(x => <li key={x}>{x}</li>)}</ol>
                  ) : (
                    <p>상담을 진행하면 단계별 조치가 표시됩니다.</p>
                  )}
                </div>
              </section>

              {assessment.based_law.length > 0 && (
                <section className="result">
                  <label>근거 법령</label>
                  <div><ul className="law-list">{assessment.based_law.map(x => <li key={x}>{x}</li>)}</ul></div>
                </section>
              )}

              <section className="attachments">
                <label>증거 자료</label>
                <div>
                  <button type="button" className="upload-btn" disabled={uploading} onClick={() => fileInput.current?.click()}>
                    {uploading ? "업로드 중…" : "📎 파일 첨부"}
                  </button>
                  {attachments.length > 0 && (
                    <ul className="file-list">
                      {attachments.map(a => (
                        <li key={a.id}>
                          <a href={attachmentDownloadUrl(a.case_id, a.id)} target="_blank" rel="noreferrer">{a.filename}</a>
                          <small>{formatBytes(a.size)}</small>
                          <button type="button" onClick={() => onDeleteAttachment(a.id)}>✕</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              <section className="notice">
                <b>꼭 확인하세요</b>
                <p>법령과 절차는 개정될 수 있습니다. 이 앱의 결과만으로 신고·징계·법적 조치를 결정하지 마세요.</p>
              </section>
            </div>
            <div className="aside-actions"><button onClick={exportPrint}>PDF로 인쇄</button></div>
          </aside>
        )}
      </div>
    </main>
  );
}