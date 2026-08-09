import fs from 'node:fs';
import path from 'node:path';
import { walkFiles } from '../fs-utils.js';
import type { NavRecognizers, ParseOutput, ParserProvider } from '../providers.js';
import type { FrameworkProfile } from '../schema.js';

export interface ParseStageInput {
  root: string;
  profile: FrameworkProfile;
  parser: ParserProvider;
  recognizers: NavRecognizers;
}

export async function parse(input: ParseStageInput): Promise<ParseOutput> {
  const { root, profile, parser } = input;
  const extensions = parser.capabilities.extensions;
  const files: string[] = [];

  for (const sourceRoot of profile.sourceRoots) {
    for (const file of walkFiles(path.join(root, sourceRoot), { extensions })) {
      if (files.includes(file)) continue;
      let source: string;
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (parser.prefilter(file, source)) files.push(file);
    }
  }

  return parser.parse({ root, files, recognizers: input.recognizers, profile });
}
