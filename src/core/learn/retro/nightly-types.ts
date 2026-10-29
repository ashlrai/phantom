/** Local ONE-TEAM observations. These records confer no execution authority. */
export type NightlyCause = 'verification' | 'scope' | 'safety' | 'review' | 'execution';

export interface NightlyJob {
  v: 1;
  id: string;
  repo: string;
  /** Provider-agnostic routing arm, supplied by the job producer. */
  arm: string;
  playbook: string | null;
  status: 'succeeded' | 'failed' | 'cancelled' | 'running' | 'blocked';
  updatedAt: string;
}

export interface NightlyReview {
  v: 1;
  id: string;
  jobId: string;
  repo: string;
  kind: 'review-block';
  updatedAt: string;
  cause: NightlyCause;
}

export interface NightlyPrior {
  repo: string;
  arm: string;
  successes: number;
  failures: number;
  /** Beta(1,1) plus observed terminal outcomes; advisory, never auto-applied. */
  alpha: number;
  beta: number;
}

export interface NightlyLesson {
  id: string;
  repo: string;
  playbook: string | null;
  cause: NightlyCause;
  status: 'pending';
  text: string;
  evidence: string[];
}

export interface NightlyProposal {
  id: string;
  status: 'proposed';
  repo: string;
  lessonId: string;
  title: string;
  prompt: string;
  evaluation: string;
  metric: string;
}

export interface NightlyState {
  v: 1;
  advisoryOnly: true;
  completedNight: string;
  jobs: NightlyJob[];
  reviews: NightlyReview[];
  priors: NightlyPrior[];
  lessons: NightlyLesson[];
  proposals: NightlyProposal[];
}
