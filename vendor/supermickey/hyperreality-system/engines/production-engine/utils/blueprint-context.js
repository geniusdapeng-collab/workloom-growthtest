/** Restore the same deterministic author context used before fresh Phase1 work. */
function hydrateProductionBlueprintContext(blueprint, log = null) {
  if (!blueprint) return blueprint;
  const theme = blueprint._creativeTheme || blueprint.metadata?._creativeTheme || {};
  if (!blueprint.genre) blueprint.genre = blueprint.type || theme.type || null;
  if (!blueprint.mood) blueprint.mood = blueprint.tone || theme.tone || null;
  if (!blueprint.theme && theme.theme) blueprint.theme = theme.theme;
  if (!blueprint.targetAudience && theme.target_audience) blueprint.targetAudience = theme.target_audience;
  if (!blueprint.description && theme.description) blueprint.description = theme.description;

  // An existing business choice and its provenance are not inferred defaults.
  if (!blueprint.filmDirector) {
    try {
      const { assignFilmDirector } = require('../../../skills/hollywood-cinematography/cinematography-skill-router');
      const director = assignFilmDirector(blueprint);
      blueprint.filmDirector = director.director;
      if (!blueprint.filmDirectorSource) blueprint.filmDirectorSource = director.source;
    } catch (error) {
      const message = `导演风格上下文不可用，保留现有业务值：${error instanceof Error ? error.message : String(error)}`;
      if (typeof log === 'function') log('DIRECTOR-CONTEXT', message);
      else console.warn(`[DIRECTOR-CONTEXT] ${message}`);
    }
  }
  return blueprint;
}

module.exports = { hydrateProductionBlueprintContext };
