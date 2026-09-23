import { expect, it } from 'vitest';
import { knowledgePropertyInput, validKnowledgeValue, knowledgeQuery, attachmentUploadSchema } from '@nextdoo/contracts';
import { knowledgeTemplates, knowledgeCsv } from './knowledge';

it.each([
  ['TITLE','Book',true],['TITLE',' ',false],['TEXT','Words',true],['RICH_TEXT','**Bold**',true],
  ['NUMBER',0,true],['NUMBER','3',false],['NUMBER',Infinity,false],['CHECKBOX',false,true],['CHECKBOX','false',false],
  ['DATE','2024-02-29',true],['DATE','2025-02-29',false],['SELECT','A',true],['SELECT','B',false],
  ['MULTI_SELECT',['A'],true],['MULTI_SELECT',['A','A'],false],['URL','https://example.org',true],['URL','javascript:alert(1)',false],
  ['URL','https://user:password@example.org',false],['EMAIL','person@example.org',true],['EMAIL','wrong',false],['PHONE','+91 555 123',true],
  ['PHONE','abc',false],['FILE','id',false],['RELATION','id',false],
] as const)('validates %s values (%s)',(type,value,expected)=>{
  const property=knowledgePropertyInput.parse({name:'Field',type,config:{options:['A']}});
  expect(validKnowledgeValue(property,typeof value==='object'?[...value]:value)).toBe(expected);
});
it('provides eleven independent editable templates with one title each',()=>{
  const templates=knowledgeTemplates();expect(templates).toHaveLength(11);
  for(const template of templates) expect(template.properties.filter(p=>p.type==='TITLE')).toHaveLength(1);
  templates[0]!.properties[0]!.name='Changed';expect(knowledgeTemplates()[0]!.properties[0]!.name).toBe('Title');
});
it('escapes CSV formulas, quotes and multiline values without losing zero or false',()=>{
  expect(knowledgeCsv(['Name'],[['=SUM(1)'],['a"b\nc'],[0],[false]])).toBe('"Name"\r\n"\'=SUM(1)"\r\n"a""b\nc"\r\n"0"\r\n"false"\r\n');
});
it('rejects invalid query bounds and ambiguous attachment parents',()=>{
  expect(knowledgeQuery.safeParse({limit:101}).success).toBe(false);expect(knowledgeQuery.safeParse({filters:'{oops'}).success).toBe(false);
  expect(attachmentUploadSchema.safeParse({fileName:'a.txt',contentType:'text/plain',sizeBytes:1}).success).toBe(false);
  expect(attachmentUploadSchema.safeParse({taskId:'11111111-1111-4111-8111-111111111111',recordId:'22222222-2222-4222-8222-222222222222',fileName:'a.txt',contentType:'text/plain',sizeBytes:1}).success).toBe(false);
});
