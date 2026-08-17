import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FrameworkProfile, NavIntent } from '@jsxray/core';
import { reactParser } from '../src/parser/react/index.js';
import { reactNavigationRecognizers } from '../src/router/react-navigation/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Writes a throwaway app and parses it with the react-navigation recognizers. */
async function parseApp(files: Record<string, string>): Promise<NavIntent[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsxray-forward-'));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const absolute = path.join(root, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source);
  }
  const output = await reactParser.parse({
    root,
    files: Object.keys(files).map((name) => path.join(root, name)),
    recognizers: reactNavigationRecognizers,
    profile: { workspaces: [] } as unknown as FrameworkProfile,
  });
  return output.navIntents.filter((intent) => intent.kind === 'link');
}

const LINK_ITEM = `
  import {Link} from './Link'
  export function LinkItem({children, ...props}) {
    return <Link {...props}><Item>{children}</Item></Link>
  }
`;

describe('links by composition (§11.2)', () => {
  it('reads a target given to a wrapper that spreads into a Link', async () => {
    const intents = await parseApp({
      'SettingsList.tsx': LINK_ITEM,
      'Page.tsx': `
        import * as SettingsList from './SettingsList'
        export default function Page() {
          return <SettingsList.LinkItem to="/settings/following-feed">Feed</SettingsList.LinkItem>
        }
      `,
    });
    expect(intents.map((intent) => intent.target)).toContain('/settings/following-feed');
  });

  it('reads it through a named import too', async () => {
    const intents = await parseApp({
      'SettingsList.tsx': LINK_ITEM,
      'Page.tsx': `
        import {LinkItem} from './SettingsList'
        export default function Page() {
          return <LinkItem to="/threads">Threads</LinkItem>
        }
      `,
    });
    expect(intents.map((intent) => intent.target)).toContain('/threads');
  });

  it('follows a wrapper around a wrapper', async () => {
    const intents = await parseApp({
      'Link.tsx': `export function Link(props) { return <a {...props} /> }`,
      'SettingsList.tsx': LINK_ITEM,
      'Row.tsx': `
        import {LinkItem} from './SettingsList'
        export function Row({...rest}) { return <LinkItem {...rest} /> }
      `,
      'Page.tsx': `
        import {Row} from './Row'
        export default function Page() { return <Row to="/deep" /> }
      `,
    });
    expect(intents.map((intent) => intent.target)).toContain('/deep');
  });

  it('leaves a wrapper that does not forward alone', async () => {
    const intents = await parseApp({
      'SettingsList.tsx': LINK_ITEM,
      'Plain.tsx': `
        export function Banner({to}) { return <View>{to}</View> }
      `,
      'Page.tsx': `
        import {Banner} from './Plain'
        export default function Page() { return <Banner to="/not-a-link" /> }
      `,
    });
    expect(intents.map((intent) => intent.target)).not.toContain('/not-a-link');
  });

  it('still reads a plain Link, and does not double-count a wrapped one', async () => {
    const intents = await parseApp({
      'SettingsList.tsx': LINK_ITEM,
      'Page.tsx': `
        import {Link} from './Link'
        import * as SettingsList from './SettingsList'
        export default function Page() {
          return <><Link to="/a" /><SettingsList.LinkItem to="/b" /></>
        }
      `,
    });
    expect(intents.map((intent) => intent.target).sort()).toEqual(['/a', '/b']);
  });
});
