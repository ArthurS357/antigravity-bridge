// Stand-in for the agy CLI, used by the test suite instead of the real
// binary. Behaviour is driven entirely by env vars so one script can play
// every scenario the bridge has to survive (success, timeout in its several
// observed shapes, resume success/failure, hangs for the Node backstop,
// output that blows past maxBuffer, and older builds missing flags).
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const log = process.env.FAKE_ARGS_LOG;
if (log) appendFileSync(log, JSON.stringify(args) + "\n");

const has = (prefix) => args.some((a) => a === prefix || a.startsWith(prefix));
const get = (prefix) => args.find((a) => a.startsWith(prefix))?.slice(prefix.length);

const CONVERSATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// ---- capability probe: --help ------------------------------------------
if (has("--help")) {
  // FAKE_HELP_OMIT is a comma-separated list of flags to hide, simulating an
  // older agy build. FAKE_NO_CONVERSATION is the original single-flag switch,
  // kept because it reads better at the call sites that only need that one.
  const omit = new Set(
    (process.env.FAKE_HELP_OMIT ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean)
  );
  if (process.env.FAKE_NO_CONVERSATION === "1") omit.add("--conversation");

  const lines = [
    ["--conversation", "  --conversation   Resume a previous conversation by ID"],
    ["--disable-slash-commands", "  --disable-slash-commands  Disable slash command and skill expansion in print mode"],
    ["--effort", "  --effort         Reasoning effort"],
    ["--json-schema", "  --json-schema    Optional JSON schema string or path"],
    ["--model", "  --model          Model for the current CLI session"],
    ["--output-format", "  --output-format  Output format for print mode"],
  ]
    .filter(([flag]) => !omit.has(flag))
    .map(([, line]) => line);

  // An agy without --conversation still documents --continue; keep that so the
  // help text is never empty and the probe has something realistic to scan.
  if (omit.has("--conversation")) {
    lines.unshift("  --continue       Continue the most recent conversation");
  }
  lines.push("  --print-timeout  Timeout for print mode wait (default 5m0s)");

  process.stderr.write(lines.join("\n"));
  process.exit(0);
}
if (has("--version")) {
  process.stdout.write("1.1.13-fake\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write(`${process.env.FAKE_MODELS ?? "gemini-3.8-flash-high\tGemini 3.8 Flash (High)"}\n`);
  process.exit(0);
}

const emit = (obj, code) => {
  process.stdout.write(JSON.stringify(obj));
  process.exit(code);
};

/** Writes until the parent's maxBuffer trips and kills us (F-01 regression). */
const flood = () => {
  const chunk = "x".repeat(1024 * 1024);
  let written = 0;
  const pump = () => {
    for (let i = 0; i < 8 && written < 80; i++, written++) process.stdout.write(chunk);
    if (written < 80) setImmediate(pump);
  };
  pump();
};

// ---- resume path ------------------------------------------------------
const resumeId = get("--conversation=");
if (resumeId !== undefined) {
  const mode = process.env.FAKE_RESUME ?? "ok";
  const base = {
    conversation_id: resumeId,
    status: "SUCCESS",
    response: `RESULTADO RECUPERADO da conversa ${resumeId}`,
    duration_seconds: 2.5,
  };
  // Partial usage: only a total, which is what the original fake reported and
  // what some agy builds actually emit.
  if (mode === "ok") emit({ ...base, usage: { total_tokens: 42 } }, 0);
  // Full accounting, for the resume cost log.
  if (mode === "ok-usage") {
    emit({ ...base, usage: { input_tokens: 1234, output_tokens: 567, total_tokens: 1801 } }, 0);
  }
  // Alternative field spelling some builds use.
  if (mode === "ok-usage-alt") {
    emit({ ...base, usage: { prompt_tokens: 100, completion_tokens: 20 } }, 0);
  }
  // Envelope with no usage block at all.
  if (mode === "ok-nousage") emit(base, 0);
  if (mode === "notfound") emit({ status: "ERROR", error: `conversation ${resumeId} not found` }, 1);
  if (mode === "empty") emit({ conversation_id: resumeId, status: "SUCCESS", response: "" }, 0);
  if (mode === "denied") {
    emit(
      {
        conversation_id: resumeId,
        status: "SUCCESS",
        response: "",
        denied_actions: [{ action: "command", display_name: "RunCommand" }],
      },
      0
    );
  }
  // The resume itself runs out of time: agy's own --print-timeout, ERROR envelope.
  if (mode === "timeout") {
    emit({ conversation_id: resumeId, status: "ERROR", error: "timeout waiting for response" }, 1);
  }
  // Same, in the agy 1.2.x shape: SUCCESS, partial text, evidence only on stderr.
  if (mode === "timeout-partial") {
    process.stderr.write(
      "[agy] print timeout after 25s with turn in progress; returning partial output\n"
    );
    emit(
      { conversation_id: resumeId, status: "SUCCESS", response: "texto parcial da retomada" },
      0
    );
  }
  if (mode === "hang") setTimeout(() => {}, 10 * 60_000);
  // fallthrough for any other value: hang, exercising the resume's own timeout.
} else {
  // ---- primary call path -----------------------------------------------
  const mode = process.env.FAKE_MODE ?? "ok";
  if (mode === "ok") {
    emit(
      {
        conversation_id: CONVERSATION_ID,
        status: "SUCCESS",
        response: "RESPOSTA NORMAL",
        duration_seconds: 1.2,
        usage: { total_tokens: 10 },
      },
      0
    );
  }
  // Echoes the received argv back as the answer, so a test can assert on the
  // exact command line without reading the args log.
  if (mode === "echo-args") {
    emit(
      {
        conversation_id: CONVERSATION_ID,
        status: "SUCCESS",
        response: JSON.stringify(args),
        duration_seconds: 0.1,
      },
      0
    );
  }
  if (mode === "structured") {
    emit(
      {
        conversation_id: CONVERSATION_ID,
        status: "SUCCESS",
        structured_output: { ok: true, itens: [1, 2] },
        duration_seconds: 0.1,
      },
      0
    );
  }
  // The exact envelope agy 1.2.5 emits when print mode soft-denies a tool it
  // cannot ask about: SUCCESS, exit 0, empty response, denial only in
  // denied_actions and on stderr. Copied from a real run — this is the shape
  // that used to reach the caller as a successful, empty answer.
  if (mode === "denied") {
    process.stderr.write(
      'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\n'
    );
    emit(
      {
        conversation_id: CONVERSATION_ID,
        status: "SUCCESS",
        response: "",
        duration_seconds: 10.6,
        usage: { input_tokens: 29102, output_tokens: 971, total_tokens: 30073 },
        denied_actions: [{ action: "command", display_name: "RunCommand" }],
      },
      0
    );
  }
  // Denial that still produced prose: content must NOT be handed back, because
  // the run did not do what it was asked to do.
  if (mode === "denied-with-text") {
    emit(
      {
        conversation_id: CONVERSATION_ID,
        status: "SUCCESS",
        response: "Aqui vai um resumo parcial que eu inventei.",
        denied_actions: [{ action: "read_file", display_name: "ViewFile" }],
      },
      0
    );
  }
  // SUCCESS with nothing in it: an empty answer is a failed run, not a result.
  if (mode === "empty-success") {
    emit({ conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "", duration_seconds: 0.4 }, 0);
  }
  // Lower-case status: a correct run must not be rejected over casing.
  if (mode === "ok-lowercase-status") {
    emit({ conversation_id: CONVERSATION_ID, status: "success", response: "RESPOSTA NORMAL" }, 0);
  }
  // agy 1.2.5 reporta um print-timeout como SUCCESS de resposta vazia, com a
  // única evidência no stderr e saída 0. Copiado de uma execução real.
  if (mode === "timeout-success-envelope") {
    process.stderr.write(
      "[agy] print timeout after 3m0s with turn in progress; returning partial output\n"
    );
    emit(
      { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "", duration_seconds: 169.8 },
      0
    );
  }
  // Timeout que corta o turno DEPOIS de o modelo já ter escrito prosa. É o caso
  // caro: o texto parece uma resposta pronta. Envelope SUCCESS, saída 0, aviso
  // só no stderr. Copiado de uma execução real do agy 1.2.5.
  if (mode === "timeout-partial-text") {
    process.stderr.write(
      "[agy] print timeout after 25s with turn in progress; returning partial output\n"
    );
    emit(
      {
        conversation_id: CONVERSATION_ID,
        status: "SUCCESS",
        response: "Analisei os 14 arquivos e nenhum apresenta problema de seguranca.",
        duration_seconds: 25.4,
      },
      0
    );
  }
  // GUARDA DE FALSO POSITIVO: execução BEM-SUCEDIDA cujo stderr contém
  // '--print-timeout'. Um /print.?timeout/ frouxo reprovaria esta resposta boa.
  if (mode === "bg-task-success") {
    process.stderr.write(
      "root agent idle; waiting for 1 background task(s) (bounded by --print-timeout)\nterminating 1 background task(s) on exit\n"
    );
    emit(
      { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "RESPOSTA NORMAL" },
      0
    );
  }
  // GUARDA DE FALSO POSITIVO: a RESPOSTA fala de timeout. stdout jamais pode
  // ser varrido em busca do marcador, senão o assunto da tarefa a reprova.
  if (mode === "timeout-word-in-answer") {
    emit(
      {
        conversation_id: CONVERSATION_ID,
        status: "SUCCESS",
        response:
          "[agy] print timeout after 25s with turn in progress - esta e a linha que o" +
          " servidor deve procurar no stderr, nunca no stdout.",
      },
      0
    );
  }
  // Real agy exits with the ERROR envelope on stdout when --print-timeout fires.
  if (mode === "timeout-exit1") {
    emit({ conversation_id: CONVERSATION_ID, status: "ERROR", error: "timeout waiting for response" }, 1);
  }
  if (mode === "timeout-exit0") {
    emit({ conversation_id: CONVERSATION_ID, status: "ERROR", error: "timeout waiting for response" }, 0);
  }
  // No envelope at all — only the id in stderr, to exercise the regex fallback.
  if (mode === "timeout-stderr") {
    process.stderr.write(`timeout waiting for response, conversation ${CONVERSATION_ID}\n`);
    process.exit(1);
  }
  // Timeout with no id anywhere: nothing to resume from.
  if (mode === "timeout-noid") {
    emit({ status: "ERROR", error: "timeout waiting for response" }, 1);
  }
  if (mode === "boom") {
    process.stderr.write("something exploded\n");
    process.exit(2);
  }
  // Reporta o cwd real do filho, que é o que o pin do process-runner controla.
  if (mode === "cwd-echo") {
    emit({ conversation_id: CONVERSATION_ID, status: "SUCCESS", response: process.cwd() }, 0);
  }
  if (mode === "flood") flood();
  if (mode === "hang") setTimeout(() => {}, 10 * 60_000);
  // Sleeps FAKE_SLEEP_MS and then succeeds, like a long agy turn. With
  // FAKE_TIMELINE_LOG set it records when it started and whether it got to the
  // end — a missing "agy-done" means something killed it first. Used to measure
  // how long the MCP client waits before giving up on a tools/call.
  if (mode === "sleep") {
    const timeline = process.env.FAKE_TIMELINE_LOG;
    const mark = (ev) => {
      if (timeline) appendFileSync(timeline, JSON.stringify({ ev, t: Date.now(), pid: process.pid }) + "\n");
    };
    mark("agy-start");
    setTimeout(() => {
      mark("agy-done");
      emit(
        { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "ACORDEI", duration_seconds: 0 },
        0
      );
    }, Number(process.env.FAKE_SLEEP_MS ?? 1000));
  }
}
