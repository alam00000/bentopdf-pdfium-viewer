export type PageLabelStyle = '' | 'D' | 'r' | 'R' | 'a' | 'A';

export interface InsertBatchPasswordFile {
  path: string;
  fileName: string;
  invalid?: boolean;
}

export interface InsertBatchPasswordRequest {
  files: InsertBatchPasswordFile[];
  onSubmit: (result: { passwords: Map<string, string>; skipped: Set<string> }) => void;
  onCancel: () => void;
  isProcessing: boolean;
}

export interface OutlineNode {
  title?: string;
  pageIndex: number;
  children?: OutlineNode[];
}

export interface PagesOps {
  rotate: (indices: number[], delta: 90 | -90) => Promise<void>;
  insertBlankAfter: (anchorIdx: number) => Promise<void>;
  insertFromFileAfter: (anchorIdx: number) => Promise<void>;
  insertFilesAfter: (anchorIdx: number, files: File[]) => Promise<void>;
  replace: (idx: number) => Promise<void>;
  extractAsPdf: (indices: number[], options?: { combine?: boolean }) => Promise<void>;
  extractAsImage: (indices: number[]) => Promise<void>;
  extractBytes: (indices: number[]) => Promise<Uint8Array | null>;
  setPageLabels: (opts: {
    style: PageLabelStyle;
    prefix: string;
    start: number;
    rangeStart: number;
    rangeEnd: number;
  }) => Promise<void>;
  cut: (indices: number[]) => Promise<void>;
  copy: (indices: number[]) => Promise<void>;
  paste: (afterIdx: number) => Promise<void>;
  duplicate: (indices: number[]) => Promise<void>;
  remove: (indices: number[]) => Promise<void>;
  reorder: (indices: number[], dropIndex: number) => Promise<void>;
  reverse: () => Promise<void>;
  exportPdf: () => Promise<{ bytes: Uint8Array; pageCount: number } | null>;
  getOutlines: () => Promise<OutlineNode[]>;
  interleaveInsert: (file: File, side: 'after' | 'before') => Promise<void>;
  setPageSize: (
    indices: number[],
    newW: number,
    newH: number,
    opts?: { onProgress?: (done: number, total: number) => void },
  ) => Promise<void>;
  splitPages: (
    indices: number[],
    axis: 0 | 1,
    fraction: number,
    rightFirst: boolean,
  ) => Promise<void>;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  clipboardHasContent: boolean;
  insertBatchPasswordRequest: InsertBatchPasswordRequest | null;
}
