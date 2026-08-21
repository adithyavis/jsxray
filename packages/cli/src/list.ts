import type { JsxrayDocument } from '@jsxray/core';

export function listDocument(document: JsxrayDocument): string {
  const lines: string[] = [];
  const profile = document.framework;

  lines.push(`stack     ${[profile?.ui, profile?.metaFramework, profile?.router].filter(Boolean).join(' · ') || 'unknown'}`);
  lines.push(
    `providers ${Object.entries(document.providers)
      .map(([axis, id]) => `${axis}=${id ?? '—'}`)
      .join('  ')}`,
  );
  lines.push(
    `stages    ${document.stages.map((stage) => `${stage.name}:${stage.status}`).join('  ')}`,
  );
  lines.push('');

  const pages = document.screens.filter((screen) => screen.isPage);
  lines.push(`screens (${pages.length})`);
  for (const screen of pages) {
    const reached = document.states.filter((state) => state.screenId === screen.id);
    const personas = [...new Set(reached.map((state) => state.personaId))];
    lines.push(
      `  ${screen.id.padEnd(40)} ${screen.componentId ?? '—'}${
        personas.length ? `  [${personas.join(', ')}]` : ''
      }`,
    );
  }

  const nonPages = document.screens.filter((screen) => !screen.isPage);
  if (nonPages.length) {
    lines.push('');
    lines.push(`non-page screens (${nonPages.length}) — never crawled, never drawn`);
    for (const screen of nonPages) lines.push(`  ${screen.id.padEnd(40)} ${screen.kind}`);
  }

  const states = document.states;
  if (states.length) {
    lines.push('');
    lines.push(`states (${states.length})`);
    for (const state of states) {
      const capture = state.captures.length
        ? state.captures.map((shot) => `${shot.viewport}:${shot.path}`).join(' ')
        : `— ${state.captureStatus}`;
      const untried = state.untriedActions.length
        ? `  (${state.untriedActions.length} untried)`
        : '';
      lines.push(
        `  ${state.personaId.padEnd(10)} ${state.signature.padEnd(40)} ${capture}${untried}`,
      );
    }
  }

  const runtimeEdges = document.edges.filter((edge) => edge.discoveredBy === 'runtime');
  lines.push('');
  lines.push(`edges     ${runtimeEdges.length} runtime, ${document.edges.length - runtimeEdges.length} candidate`);
  for (const edge of runtimeEdges) {
    lines.push(`  ${edge.fromState} --${edge.label ?? edge.kind}--> ${edge.toState}`);
  }

  if (document.coverage) {
    const { overall } = document.coverage;
    lines.push('');
    lines.push('coverage');
    lines.push(
      `  screens  ${overall.screensReached}/${overall.screensDeclared ?? '—'}${
        overall.screenRatio === null ? '' : `  ${percent(overall.screenRatio)}`
      }`,
    );
    lines.push(
      `  edges    ${overall.edgesConfirmed}/${overall.edgesMatchable}${
        overall.edgeRatio === null ? '' : `  ${percent(overall.edgeRatio)}`
      }  (${overall.edgesUnmatchable} unmatchable)`,
    );
  }

  if (document.diagnostics.length) {
    lines.push('');
    lines.push(`diagnostics (${document.diagnostics.length})`);
    for (const diagnostic of document.diagnostics) {
      lines.push(`  ${diagnostic.level.padEnd(5)} ${diagnostic.stage.padEnd(10)} ${diagnostic.message}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
