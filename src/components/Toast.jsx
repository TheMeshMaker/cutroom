import Icon from "./icons.jsx";

// Bottom-center notice. Destructive edits get an Undo button.
export default function Toast({ toast, onUndo, onClose }) {
  return (
    <div className={`toast ${toast.kind}`} role="status">
      <Icon name={toast.kind === "error" ? "alert" : toast.undo ? "info" : "check"} size={16} />
      <span className="toast-text">{toast.text}</span>
      {toast.undo && onUndo && (
        <button className="toast-action" onClick={onUndo}>
          Undo
        </button>
      )}
      <button className="toast-close" onClick={onClose} aria-label="Dismiss">
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
