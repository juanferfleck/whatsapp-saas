import { PenLine, Bot, Smartphone, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MessageRow } from "@/features/inbox/types";
import { StatusIcon } from "./status-icon";
import { MessageAttachment } from "./message-attachment";

interface ChatMessageProps {
  message: MessageRow;
}

/** Author chip for outbound messages: "IA" badge, "WhatsApp" (native app), or the operator's name. */
function OutboundAuthor({ message }: { message: MessageRow }) {
  // Sent from the business's native WhatsApp Business App (coexistence echo),
  // not through the panel — has no sender_user_id either, so it must be
  // checked before the AI fallback below or it would be mislabeled as IA.
  if ((message.meta as Record<string, unknown> | null)?.source === "whatsapp_business_app") {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-foreground/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-foreground/70">
        <Smartphone className="h-2.5 w-2.5" aria-hidden="true" />
        WhatsApp
      </span>
    );
  }

  // Sent by another system through the same number (e.g. booking confirmations
  // and reminders) — not the AI and not a person. Like the case above it has no
  // sender_user_id, so it must be checked before the AI fallback.
  if ((message.meta as Record<string, unknown> | null)?.source === "external_automation") {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-foreground/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-foreground/70">
        <Zap className="h-2.5 w-2.5" aria-hidden="true" />
        Automático
      </span>
    );
  }

  // AI-generated when there is no human sender.
  if (!message.sender_user_id) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-primary/15 px-1 text-[9px] font-semibold uppercase tracking-wide text-primary">
        <Bot className="h-2.5 w-2.5" aria-hidden="true" />
        IA
      </span>
    );
  }
  const name = message.sender?.full_name ?? "Operador";
  const initial = name.trim()[0]?.toUpperCase() ?? "·";
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-foreground/15 text-[8px] font-semibold text-foreground">
        {initial}
      </span>
      {name}
    </span>
  );
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("es", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function isInternalNote(message: MessageRow): boolean {
  return (
    message.type === "system" &&
    message.meta != null &&
    (message.meta as Record<string, unknown>).internal === true
  );
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isOutbound = message.direction === "out";
  const time = formatTime(message.created_at);
  const internal = isInternalNote(message);

  // Internal note — centered, amber tint, italic
  if (internal) {
    return (
      <div className="flex justify-center my-1" role="note">
        <div className="max-w-[80%] rounded-lg px-3 py-2 space-y-1 bg-warning/8 border border-warning/20">
          <div className="flex items-center gap-1.5 text-warning">
            <PenLine className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="text-[10px] font-medium uppercase tracking-wide">
              Nota interna
            </span>
          </div>
          {message.body && (
            <p className="text-sm text-foreground/80 italic leading-relaxed whitespace-pre-wrap break-words">
              {message.body}
            </p>
          )}
          <div className="flex justify-end">
            <span
              className="font-mono text-[10px] text-muted-foreground/60"
              suppressHydrationWarning
            >
              {time}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex", isOutbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-lg px-3 py-2 space-y-1",
          isOutbound
            ? "bg-primary/10 border border-primary/30 rounded-tr-sm"
            : "bg-muted/50 rounded-tl-sm",
        )}
      >
        {/* Templates carry their rendered text in `body` and have no media, so
            they render like text — sending them to MessageAttachment would
            leave them stuck on "Descargando archivo…". */}
        {message.type !== "text" &&
        message.type !== "system" &&
        message.type !== "template" ? (
          <MessageAttachment media={message.meta} type={message.type} />
        ) : (
          message.body && (
            <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap break-words">
              {message.body}
            </p>
          )
        )}

        <div
          className={cn(
            "flex items-center gap-1",
            isOutbound ? "justify-end" : "justify-start",
          )}
        >
          {isOutbound && message.type !== "system" && (
            <OutboundAuthor message={message} />
          )}
          <span
            className="font-mono text-[10px] text-muted-foreground"
            suppressHydrationWarning
          >
            {time}
          </span>
          {isOutbound && <StatusIcon status={message.status} />}
        </div>
      </div>
    </div>
  );
}
