import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type DialogVariant = "default" | "danger";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
}

interface PromptOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Allow confirming with an empty value (e.g. clear due time). */
  allowEmpty?: boolean;
}

type DialogState =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (v: string | null) => void };

interface DialogContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within DialogProvider");
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setDialog({ kind: "confirm", options, resolve });
      }),
    []
  );

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setPromptValue(options.defaultValue ?? "");
        setDialog({ kind: "prompt", options, resolve });
      }),
    []
  );

  const close = useCallback((result: boolean | string | null) => {
    if (!dialog) return;
    if (dialog.kind === "confirm") {
      dialog.resolve(result === true);
    } else {
      dialog.resolve(typeof result === "string" ? result : null);
    }
    setDialog(null);
    setPromptValue("");
  }, [dialog]);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(dialog.kind === "confirm" ? false : null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, close]);

  useEffect(() => {
    if (dialog?.kind === "prompt") {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [dialog]);

  const isDanger = dialog?.kind === "confirm" && dialog.options.variant === "danger";

  function submitPrompt() {
    if (!dialog || dialog.kind !== "prompt") return;
    const v = promptValue.trim();
    if (v || dialog.options.allowEmpty) {
      close(v);
    }
  }

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      {dialog && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onClick={() => close(dialog.kind === "confirm" ? false : null)}
        >
          <div
            className="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="dialog-title" className="dialog-title">
              {dialog.options.title}
            </h2>
            {"message" in dialog.options && dialog.options.message && (
              <p className="dialog-message">{dialog.options.message}</p>
            )}
            {dialog.kind === "prompt" && (
              <input
                ref={inputRef}
                className="capture-input dialog-input"
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitPrompt();
                  }
                }}
              />
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="btn secondary"
                onClick={() => close(dialog.kind === "confirm" ? false : null)}
              >
                {dialog.options.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                className={isDanger ? "btn danger" : "btn"}
                onClick={() => {
                  if (dialog.kind === "confirm") {
                    close(true);
                  } else {
                    submitPrompt();
                  }
                }}
              >
                {dialog.options.confirmLabel ??
                  (dialog.kind === "confirm" ? "OK" : "Save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}
