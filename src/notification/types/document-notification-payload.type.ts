export type DocumentNotificationPayload =
  | {
      type: 'document-processing';
      documentId: string;
      filename: string;
      status: 'processing';
    }
  | {
      type: 'document-ready';
      documentId: string;
      filename: string;
      status: 'ready';
      processedAt: string;
    }
  | {
      type: 'document-failed';
      documentId: string;
      filename: string;
      status: 'failed';
      error: string;
    }
  | {
      type: 'document-reindex-processing';
      documentId: string;
      filename: string;
      status: 'processing';
    }
  | {
      type: 'document-reindex-ready';
      documentId: string;
      filename: string;
      status: 'ready';
      processedAt: string;
    }
  | {
      type: 'document-reindex-failed';
      documentId: string;
      filename: string;
      status: 'failed';
      error: string;
    };
