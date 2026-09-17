export interface MemoryRecord {
  id: string;
  key: string;
  value: string;
  createdAt: string;
}

export interface SaveMemoryInput {
  key: string;
  value: string;
}
