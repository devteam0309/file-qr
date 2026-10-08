import { useId, useRef, useState, type DragEvent, type KeyboardEvent, type Ref } from 'react';
import { buttonStyles } from './ui';

interface Props {
  maxUploadMb: number;
  onFile: (file: File) => void;
  /** Ref to the "Choose file" button, so the parent can move focus back to it. */
  buttonRef?: Ref<HTMLButtonElement>;
}

/** Drop zone (focusable; Enter/Space opens the picker) plus an explicit "Choose file" button. */
export function UploadZone({ maxUploadMb, onFile, buttonRef }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const hintId = useId();

  const openPicker = () => inputRef.current?.click();

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }

  return (
    <div className="space-y-4">
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop zone: drop a file here, or press Enter to choose one"
        aria-describedby={hintId}
        onClick={openPicker}
        onKeyDown={handleKeyDown}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
        }}
        onDrop={handleDrop}
        className={`flex min-h-56 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragActive
            ? 'border-indigo-600 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950'
            : 'border-slate-300 bg-slate-50 hover:border-indigo-500 hover:bg-indigo-50/50 dark:border-slate-700 dark:bg-slate-950 dark:hover:bg-slate-900'
        }`}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-10 w-10 text-indigo-700 dark:text-indigo-400" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <p className="text-base font-medium">{dragActive ? 'Drop to upload' : 'Drag and drop a file here'}</p>
        <p id={hintId} className="text-sm text-slate-600 dark:text-slate-400">
          Any file type, up to {maxUploadMb} MB
        </p>
      </div>

      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
        <span className="text-sm text-slate-600 dark:text-slate-400">or</span>
        <span aria-hidden="true" className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
      </div>

      <button ref={buttonRef} type="button" onClick={openPicker} className={`${buttonStyles.primary} w-full`}>
        Choose file
      </button>

      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // allow choosing the same file again
          if (file) onFile(file);
        }}
      />
    </div>
  );
}
