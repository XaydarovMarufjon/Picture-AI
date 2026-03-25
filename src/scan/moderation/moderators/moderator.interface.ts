export interface ModerationResult {
  provider: string;       // qaysi provider (huggingface | sightengine)
  label: string;          // AI chiqargan label
  score?: number | null;  // ishonchlilik balli
  raw?: any;              // original javob
}

export interface IModerator {
  check(imageUrl: string): Promise<ModerationResult>;
  checkBuffer?(buffer: Buffer): Promise<ModerationResult>;

}
