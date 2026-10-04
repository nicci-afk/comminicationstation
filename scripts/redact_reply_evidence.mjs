import fs from 'node:fs';import path from 'node:path';
const root=process.argv[2];
for(const name of fs.readdirSync(root)){
 if(!/\.(log|tap)$/.test(name))continue;const p=path.join(root,name);
 let s=fs.readFileSync(p,'utf8').replace(/\u001b\[[0-9;]*m/g,'');
 s=s.replace(/^.*(?:anon key|service_role key|Secret key|Publishable key|JWT secret|S3 Access Key|S3 Secret Key).*$/gmi,'[local credential summary redacted]')
 .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[local JWT redacted]')
 .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g,'[local key redacted]')
 .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/g,'$1[redacted]@');fs.writeFileSync(p,s);
}
