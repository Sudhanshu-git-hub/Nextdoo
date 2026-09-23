import { knowledgePropertyInput, type KnowledgePropertyInput, type KnowledgeValue } from '@nextdoo/contracts';

export function knowledgeTemplates() {
  const property = (name: string, type: KnowledgePropertyInput['type'], options: string[] = []) => knowledgePropertyInput.parse({ name, type, config: { options } });
  const examples: Array<{ id: string; name: string; fields: KnowledgePropertyInput[] }> = [
    { id: 'books', name: 'Books', fields: [property('Author', 'TEXT'), property('Status', 'SELECT', ['To read', 'Reading', 'Read']), property('Pages', 'NUMBER'), property('Finished', 'DATE')] },
    { id: 'courses', name: 'Courses', fields: [property('Provider', 'TEXT'), property('Status', 'SELECT', ['Planned', 'Learning', 'Complete']), property('Course link', 'URL')] },
    { id: 'study-notes', name: 'Study Notes', fields: [property('Subject', 'TEXT'), property('Summary', 'RICH_TEXT'), property('Reviewed', 'CHECKBOX')] },
    { id: 'workout-log', name: 'Workout Log', fields: [property('Date', 'DATE'), property('Minutes', 'NUMBER'), property('Activity', 'SELECT', ['Walk', 'Strength', 'Cardio', 'Other'])] },
    { id: 'finance', name: 'Finance', fields: [property('Date', 'DATE'), property('Amount', 'NUMBER'), property('Category', 'TEXT')] },
    { id: 'movies', name: 'Movies/Shows', fields: [property('Status', 'SELECT', ['Watchlist', 'Watching', 'Watched']), property('Rating', 'NUMBER')] },
    { id: 'recipes', name: 'Recipes', fields: [property('Ingredients', 'RICH_TEXT'), property('Minutes', 'NUMBER'), property('Source', 'URL')] },
    { id: 'research', name: 'Research', fields: [property('Source', 'URL'), property('Summary', 'RICH_TEXT'), property('Resources', 'FILE')] },
    { id: 'journal', name: 'Journal', fields: [property('Date', 'DATE'), property('Reflection', 'RICH_TEXT')] },
    { id: 'contacts', name: 'Contacts', fields: [property('Email', 'EMAIL'), property('Phone', 'PHONE'), property('Groups', 'MULTI_SELECT', ['Family', 'Friends', 'Work'])] },
    { id: 'personal-projects', name: 'Personal Projects', fields: [property('Status', 'SELECT', ['Idea', 'Active', 'Complete']), property('Target date', 'DATE'), property('Related work', 'RELATION')] },
  ];
  return examples.map(({ id, name, fields }) => ({ id, name, description: `An editable starting point for ${name.toLowerCase()}.`, properties: [property('Title', 'TITLE'), ...fields] }));
}

/** Spreadsheet-safe cells: formula prefixes stay literal on CSV import. */
export function knowledgeCsv(headers: string[], rows: Array<Array<KnowledgeValue | undefined>>) {
  const cell = (value: KnowledgeValue | undefined) => {
    let text = value === null || value === undefined ? '' : Array.isArray(value) ? value.join('; ') : String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
