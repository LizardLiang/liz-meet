// src/components/DeleteConfirmDialog.tsx
// Confirmation dialog for session deletion.

interface Props {
  sessionTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function DeleteConfirmDialog({ sessionTitle, onConfirm, onCancel }: Props) {
  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg">Delete session?</h3>
        <p className="py-4 text-base-content/70">
          This will permanently delete{' '}
          <strong>&ldquo;{sessionTitle}&rdquo;</strong> and its transcript.
          Audio files will also be removed. This cannot be undone.
        </p>
        <div className="modal-action">
          <button className="btn btn-outline" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-error" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
      <div className="modal-backdrop" onClick={onCancel} />
    </div>
  );
}
