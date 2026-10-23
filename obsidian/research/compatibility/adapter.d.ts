/** Normalized protocol for an independent app; no Obsidian classes are required. */
export interface Query { linkpath: string; sourcePath: string; }
export interface Reference {
  kind: 'link' | 'embed' | 'frontmatter';
  original?: string | null;
  link: string;
  subpath: string;
  /** Resolved target path relative to the vault; null means unresolved. */
  path: string | null;
}
export interface Settings { alwaysUpdateLinks: boolean; newLinkFormat: 'shortest'; useMarkdownLinks: boolean; }
export interface FileSnapshot { text: string; references: Reference[]; }
export interface ResolutionCase { id: string; files: Record<string,string>; queries: Query[]; }
export interface MutationCase {
  id: string; files: Record<string,string>; settings: Partial<Settings>;
  action: {kind:'rename'; via:'storage'|'managed'; path:string; newPath:string; decision:'automatic'|'decline'|'once'|'always'} |
    {kind:'create'; path:string; text:string};
}
export interface Corpus { schema:'obsidian-compat-input-v1'; resolution:ResolutionCase[]; renames:MutationCase[]; }
export type Observation = {
  id:string; kind:'resolve'; settle:{status:'stable-observed'};
  queries:(Query & {path:string|null})[];
  references:Record<string,Reference[]>;
} | {
  id:string; kind:'rename'|'create'; settle:{status:'stable-observed'};
  operationError?:string|null;
  /** null when no prompt was presented; otherwise any non-null prompt observation. */
  prompt:unknown|null;
  after:{files:Record<string,FileSnapshot>;settings:Settings};
};
export interface SuiteObservation { status:'complete'|'failed'; results:Observation[]; error?:string|null; }
/** Implement this export in a local adapter module and run run-adapter.mjs. */
export declare function runSuite(corpus:Corpus):Promise<SuiteObservation>;
