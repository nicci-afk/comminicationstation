import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('../apps/web/node_modules/typescript');
const root=process.cwd();const declaration=path.join(root,'test-results/reply-deno-fixture.d.ts');fs.mkdirSync(path.dirname(declaration),{recursive:true});fs.writeFileSync(declaration,'declare const Deno: { env: { get(name: string): string | undefined } };');
const options={noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,allowImportingTsExtensions:true,paths:{'@supabase/supabase-js':[path.join(root,'apps/web/node_modules/@supabase/supabase-js/dist/index.d.mts')]}};
const files=['supabase/functions/api/reply-review.ts','supabase/functions/api/gmail-send.ts','supabase/functions/api/twilio-send.ts','supabase/functions/api/gmail-get-body.ts'];
const program=ts.createProgram([...files.map(f=>path.join(root,f)),declaration],options);
const diagnostics=ts.getPreEmitDiagnostics(program).map(d=>({code:d.code,file:d.file?.fileName.replace(root+'/',''),message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}));
console.log(JSON.stringify({typescript:ts.version,scope:'Actual new review handler + both send routes, actual local SDK types and Deno env fixture; not native Deno.',diagnostics},null,2));
if(diagnostics.length)process.exitCode=1;
