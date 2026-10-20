export interface ReviewPayload {
  round: string;
  research_notes: string;
  ai_verdict: string;
  ai_critique: string;
  instructions: string;
}

export interface ResearchResponse {
  thread_id: string;
  status: "awaiting_review" | "completed";
  review: ReviewPayload | null;
  filename: string | null;
  research_notes: string | null;
}

export interface ProgressEvent {
  node: string;
  message: string;
}
