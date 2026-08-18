export type DocumentProcessingJobData = {
  documentId: string;
  filename: string;
  fileBufferBase64: string;
  uploadedByUserId: string;
  siteId: string;
  chunkSize: number;
  chunkOverlap: number;
};

export type DocumentReindexJobData = {
  documentId: string;
  uploadedByUserId: string;
  siteId: string;
  chunkSize: number;
  chunkOverlap: number;
};
