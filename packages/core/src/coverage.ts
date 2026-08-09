import type { Coverage, CoverageEntry, Edge, JsxrayDocument, ScreenState } from './schema.js';

/** §5.1 — confirmed / unconfirmed / unmatchable; unmatchable is out of the denominator. */
export function computeCoverage(document: JsxrayDocument): Coverage {
  const declared = document.screens.filter((screen) => screen.isPage);
  const hasManifest = document.stages.some(
    (stage) => stage.name === 'enumerate' && stage.status === 'ok',
  );
  const candidates = document.edges.filter((edge) => edge.discoveredBy === 'static');
  const runtime = document.edges.filter((edge) => edge.discoveredBy === 'runtime');

  const entry = (states: ScreenState[], edges: Edge[]): CoverageEntry => {
    const reachedScreens = new Set(states.map((state) => state.screenId));
    const confirmedKeys = new Set(
      edges.map((edge) => edge.matchKey).filter((key): key is string => key !== null),
    );

    let confirmed = 0;
    let unconfirmed = 0;
    let unmatchable = 0;
    for (const candidate of candidates) {
      if (candidate.matchKey === null) unmatchable++;
      else if (confirmedKeys.has(candidate.matchKey)) confirmed++;
      else unconfirmed++;
    }

    const matchable = confirmed + unconfirmed;
    return {
      screensDeclared: hasManifest ? declared.length : null,
      screensReached: reachedScreens.size,
      screenRatio: hasManifest && declared.length ? reachedScreens.size / declared.length : null,
      edgesConfirmed: confirmed,
      edgesUnconfirmed: unconfirmed,
      edgesUnmatchable: unmatchable,
      edgesMatchable: matchable,
      edgeRatio: matchable ? confirmed / matchable : null,
    };
  };

  const byPersona: Record<string, CoverageEntry> = {};
  for (const persona of document.personas) {
    byPersona[persona.id] = entry(
      document.states.filter((state) => state.personaId === persona.id),
      runtime.filter((edge) => edge.personaId === persona.id),
    );
  }

  return { overall: entry(document.states, runtime), byPersona };
}

/** Stamp each candidate with the runtime edges that confirmed it. */
export function markConfirmedEdges(document: JsxrayDocument): void {
  const byKey = new Map<string, string[]>();
  for (const edge of document.edges) {
    if (edge.discoveredBy !== 'runtime' || !edge.matchKey) continue;
    const list = byKey.get(edge.matchKey) ?? [];
    list.push(edge.id);
    byKey.set(edge.matchKey, list);
  }
  for (const edge of document.edges) {
    if (edge.discoveredBy !== 'static') continue;
    edge.confirmedBy = edge.matchKey ? (byKey.get(edge.matchKey) ?? []) : null;
  }
}
