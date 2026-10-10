export function fillPromptTemplate(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
}
