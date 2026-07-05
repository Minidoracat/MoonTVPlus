const SHORT_ALIAS_LENGTH = 2;

export function titleMatchesSearchOrAlias(
  title: string,
  query: string,
  aliases: string[],
  exactSearch: boolean
): boolean {
  if (!exactSearch) return true;
  if (!query || !title) return true;

  const normalizedTitle = title.toLowerCase();
  const normalizedQuery = query.toLowerCase();

  if (normalizedTitle.includes(normalizedQuery)) return true;

  return aliases.some((alias) => {
    const normalizedAlias = alias.trim().toLowerCase();
    if (!normalizedAlias) return false;

    // ponytail: short aliases like "功夫" are too broad for contains matching.
    return normalizedAlias.length <= SHORT_ALIAS_LENGTH
      ? normalizedTitle === normalizedAlias
      : normalizedTitle.includes(normalizedAlias);
  });
}
