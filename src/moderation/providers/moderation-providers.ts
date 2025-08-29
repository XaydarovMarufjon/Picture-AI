export type ModerationResult = {
scoreAdult?: number; // 0..1
scoreViolence?: number; // 0..1
labels?: string[]; // qo'shimcha teglash
};


export interface IModerationProvider {
name: string;
analyze(buffer: Buffer, mime?: string): Promise<ModerationResult>;
}