import { useState } from "react";
import type { ReactNode } from "react";

type MessageBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "code"; language: string; code: string };

const linkPattern = /\[([^\]]+)\]\((\S+(?:\([^)]*\)\S*)?)\)|`([^`]+)`/g;
const safeProtocols = new Set(["http:", "https:", "mailto:"]);
const codeTokenPattern =
  /(\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:async|await|class|const|else|export|function|if|import|interface|let|return|type)\b)/g;

function safeHref(raw: string): string | undefined {
  try {
    const url = new URL(raw, window.location.origin);
    return safeProtocols.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function parseBlocks(markdown: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let code: string[] | undefined;
  let language = "";

  function flushParagraph() {
    const text = paragraph.join("\n").trim();
    if (text.length > 0) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  }

  for (const line of lines) {
    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fence !== null) {
      if (code === undefined) {
        flushParagraph();
        language = fence[1] ?? "";
        code = [];
      } else {
        blocks.push({ kind: "code", language, code: code.join("\n") });
        code = undefined;
        language = "";
      }
      continue;
    }
    if (code !== undefined) {
      code.push(line);
      continue;
    }
    if (line.trim().length === 0) flushParagraph();
    else paragraph.push(line);
  }
  if (code !== undefined)
    blocks.push({ kind: "code", language, code: code.join("\n") });
  flushParagraph();
  return blocks.length > 0 ? blocks : [{ kind: "paragraph", text: "" }];
}

function renderInline(text: string) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(linkPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const [, label, href, code] = match;
    if (code !== undefined) {
      nodes.push(<code key={`code-${index}`}>{code}</code>);
    } else if (label !== undefined && href !== undefined) {
      const safe = safeHref(href);
      nodes.push(
        safe === undefined ? (
          <span key={`link-${index}`}>{label}</span>
        ) : (
          <a key={`link-${index}`} href={safe} rel="noreferrer">
            {label}
          </a>
        ),
      );
    }
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function highlightCode(code: string) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of code.matchAll(codeTokenPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(code.slice(cursor, index));
    const token = match[0];
    const kind = token.startsWith("//")
      ? "comment"
      : token.startsWith("'") || token.startsWith('"')
        ? "string"
        : "keyword";
    nodes.push(
      <span
        key={`${kind}-${index}`}
        className={`code-token code-token--${kind}`}
      >
        {token}
      </span>,
    );
    cursor = index + token.length;
  }
  if (cursor < code.length) nodes.push(code.slice(cursor));
  return nodes;
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  async function copy() {
    try {
      if (navigator.clipboard === undefined)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    } finally {
      window.setTimeout(() => setCopyState("idle"), 1200);
    }
  }
  return (
    <figure className="message-code">
      <figcaption>
        <span>{language || "code"}</span>
        <button type="button" onClick={() => void copy()}>
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Copy failed"
              : "Copy"}
        </button>
      </figcaption>
      <pre>
        <code>{highlightCode(code)}</code>
      </pre>
    </figure>
  );
}

export function MessageContent({ content }: { content: string }) {
  return (
    <div className="message-content">
      {parseBlocks(content).map((block, index) =>
        block.kind === "code" ? (
          <CodeBlock
            key={`code-${index}`}
            code={block.code}
            language={block.language}
          />
        ) : (
          <p key={`p-${index}`}>{renderInline(block.text)}</p>
        ),
      )}
    </div>
  );
}
