"""Local tests only. API responses are fixtures; no deployment/network mutation."""
import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import atexit

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/mcc_frontend_release.py'
spec = importlib.util.spec_from_file_location('controller', SCRIPT)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
WF_PATH = ROOT / '.github/workflows/mcc-phase3b-production.yml'
WORKFLOW = WF_PATH.read_text()
SOURCE_REF = os.environ.get('REPLY_RELEASE_SOURCE_REF', m.CANDIDATE)
fixture_temp = tempfile.TemporaryDirectory(prefix='mcc-controller-proof-')
atexit.register(fixture_temp.cleanup)
FIXTURE = Path(fixture_temp.name)
for entry in subprocess.check_output(['git', '-C', str(ROOT), 'ls-tree', '-rz', f'{SOURCE_REF}:apps/web']).split(b'\0'):
    if not entry: continue
    info, name = entry.split(b'\t', 1); mode, kind, blob = info.decode().split()
    if kind != 'blob': raise AssertionError('Unexpected source mode')
    target = FIXTURE / 'apps/web' / name.decode(); target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(subprocess.check_output(['git', '-C', str(ROOT), 'cat-file', 'blob', blob]))
subprocess.run(['git','init','-q',str(FIXTURE)], check=True)
subprocess.run(['git','-C',str(FIXTURE),'add','apps/web'], check=True)
subprocess.run(['git','-C',str(FIXTURE),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic exact frontend fixture'], check=True)
FIXTURE_COMMIT = subprocess.check_output(['git', '-C', str(FIXTURE), 'rev-parse', 'HEAD'], text=True).strip()
BASE_ENV = {'GITHUB_REPOSITORY':m.REPOSITORY,'GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ID':'12345','GITHUB_RUN_ATTEMPT':'1','CONFIRMATION':m.CANDIDATE,'OPERATION':'deploy','RELEASE_DEPLOYMENT_ID':''}
PROJECT = {'id':m.PROJECT,'accountId':m.TEAM,'name':'message-command-center','framework':'vite','rootDirectory':None,'buildCommand':None,'installCommand':None,'outputDirectory':None,'nodeVersion':'24.x','link':None,'autoAssignCustomDomains':True,'crons':{'definitions':[], 'enabledAt':123}}
DOMAIN = {'domains':[{'name':m.DOMAINS[0],'projectId':m.PROJECT,'verified':True,'redirect':None,'gitBranch':None,'customEnvironmentId':None}], 'pagination':{'next':None}}
BASELINE = {'id':m.BASELINE_ID,'projectId':m.PROJECT,'target':'production','readyState':'READY','meta':{'mccSourceCommit':m.BASELINE_SHA,'mccSourceTree':m.BASELINE_TREE,'mccSourceManifest':m.BASELINE_MANIFEST},'aliasError':None}
NEW_ID='dpl_NewApproved123'
CANDIDATE = {'id':NEW_ID,'projectId':m.PROJECT,'target':'production','readyState':'READY','meta':{'mccSourceCommit':m.CANDIDATE,'mccSourceTree':m.WEB_TREE,'mccSourceManifest':m.MANIFEST_SHA256},'aliasError':None}

@contextlib.contextmanager
def cwd(path):
    old = Path.cwd(); os.chdir(path)
    try: yield
    finally: os.chdir(old)

def records():
    result=[]
    for line in subprocess.check_output(['git','-C',str(FIXTURE),'ls-tree','-rz',f'{FIXTURE_COMMIT}:apps/web']).split(b'\0'):
        if line:
            info,path=line.split(b'\t',1);mode,kind,sha=info.decode().split()
            result.append((path.decode(),mode,subprocess.check_output(['git','-C',str(FIXTURE),'cat-file','blob',sha])))
    return result

class FakeAPI:
    def __init__(self, operation='deploy', failure=None):
        self.operation=operation;self.failure=failure;self.posts=[];self.mutated=False;self.later=[{'uid':m.RECONCILED_FAILURE_ID,'state':'ERROR'}]
    def json(self, service, path, body=None):
        if body is not None:
            self.posts.append((path,body))
            if self.failure=='uncertain': raise RuntimeError('uncertain POST')
            self.mutated=True
            return {'id':NEW_ID}
        if service=='github':
            run = next((r for r in m.CI_RUNS if f'/runs/{r[0]}' in path), None)
            if run is None: raise AssertionError(path)
            if '/jobs?' in path:return {'total_count':len(run[2]),'jobs':[{'name':n,'status':'completed','conclusion':'success'} for n in run[2]]}
            return {'head_sha':m.CANDIDATE,'status':'completed','conclusion':'success','path':run[1]}
        if '/domains?' in path:return copy.deepcopy(DOMAIN)
        if path.startswith('/v6/deployments?'):return {'pagination':{'count':len(self.later),'next':None},'deployments':self.later}
        if path.startswith('/v9/projects/'):
            value=copy.deepcopy(PROJECT)
            if self.operation=='rollback' and self.mutated:value['autoAssignCustomDomains']=False
            return value
        raise AssertionError(path)
    def deployment(self, identity):
        if identity==m.RECONCILED_FAILURE_ID:return {'id':identity,'projectId':m.PROJECT,'target':'production','readyState':'ERROR','createdAt':m.RECONCILED_FAILURE_CREATED_AT,'meta':copy.deepcopy(m.RECONCILED_FAILURE_META)}
        if identity in (m.BASELINE_ID,m.BASELINE_URL):return copy.deepcopy(BASELINE)
        if identity==m.DOMAINS[0]:
            return copy.deepcopy(CANDIDATE if ((self.operation=='deploy' and self.mutated) or (self.operation=='rollback' and not self.mutated)) else BASELINE)
        if identity==NEW_ID:
            value=copy.deepcopy(CANDIDATE)
            if self.failure in ('ERROR','CANCELED','CANCELLED','BUILDING'):value['readyState']=self.failure
            if self.failure=='alias':value['aliasError']={'code':'failed'}
            return value
        raise AssertionError(identity)

class ControllerTests(unittest.TestCase):
    def test_manual_read_only_permissions_and_auth_gates(self):
        self.assertIn('  workflow_dispatch:',WORKFLOW)
        self.assertNotIn('  push:',WORKFLOW);self.assertNotIn('  pull_request:',WORKFLOW)
        self.assertIn('  contents: read',WORKFLOW);self.assertIn('  actions: read',WORKFLOW)
        self.assertNotIn('write',WORKFLOW);self.assertIn('default: inspect',WORKFLOW)
        self.assertEqual(m.RELEASE_AUTHORIZATION,'APPROVED');self.assertEqual(m.ROLLBACK_AUTHORIZATION,'NOT_GRANTED')
        with patch.dict(os.environ,BASE_ENV,clear=True), patch.object(m,'RELEASE_AUTHORIZATION','NOT_GRANTED'), self.assertRaises(RuntimeError):m.validate_operation('deploy',m.CANDIDATE,'')
        with patch.dict(os.environ,BASE_ENV,clear=True), patch.object(m,'ROLLBACK_AUTHORIZATION','NOT_GRANTED'), self.assertRaises(RuntimeError):m.validate_operation('rollback',m.BASELINE_ID,NEW_ID)
    def test_workflow_syntax_and_helper_hash(self):
        shell = WORKFLOW.split('run: |',1)[1]
        subprocess.run(['bash','-n'],input='\n'.join(line[10:] for line in shell.splitlines()),text=True,check=True)
        self.assertIn(hashlib.sha256(SCRIPT.read_bytes()).hexdigest(),WF_PATH.read_text())
    def test_allowed_operation_and_target_guards(self):
        with patch.dict(os.environ,BASE_ENV,clear=True),patch.object(m,'RELEASE_AUTHORIZATION','APPROVED'),patch.object(m,'ROLLBACK_AUTHORIZATION','APPROVED'):
            m.validate_operation('inspect','','');m.validate_operation('deploy',m.CANDIDATE,'');m.validate_operation('rollback',m.BASELINE_ID,NEW_ID)
            with patch.dict(os.environ,{'GITHUB_RUN_ATTEMPT':'2'}),self.assertRaises(RuntimeError):m.validate_operation('rollback',m.BASELINE_ID,NEW_ID)
            for op,confirmation,identity in [('deploy','wrong',''),('deploy',m.CANDIDATE,NEW_ID),('rollback',m.BASELINE_ID,''),('rollback',m.BASELINE_ID,m.BASELINE_ID),('other','','')]:
                with self.subTest(op=op,confirmation=confirmation,identity=identity),self.assertRaises(RuntimeError):m.validate_operation(op,confirmation,identity)
            for key,val in [('GITHUB_REPOSITORY','other/repo'),('GITHUB_REF','refs/heads/feature'),('GITHUB_EVENT_NAME','push'),('GITHUB_RUN_ATTEMPT','2')]:
                with self.subTest(key=key),patch.dict(os.environ,{key:val}),self.assertRaises(RuntimeError):m.validate_operation('deploy',m.CANDIDATE,'')
    def test_exact_preflight_branch_can_only_inspect(self):
        with patch.dict(os.environ,{**BASE_ENV,'GITHUB_REF':f'refs/heads/{m.INSPECT_BRANCH}'},clear=True),patch.object(m,'RELEASE_AUTHORIZATION','APPROVED'),patch.object(m,'ROLLBACK_AUTHORIZATION','APPROVED'):
            m.validate_operation('inspect','','')
            with self.assertRaises(RuntimeError):m.validate_operation('deploy',m.CANDIDATE,'')
            with self.assertRaises(RuntimeError):m.validate_operation('rollback',m.BASELINE_ID,NEW_ID)
            with patch.dict(os.environ,{'GITHUB_REF':'refs/heads/other'}),self.assertRaises(RuntimeError):m.validate_operation('inspect','','')
    def test_settings_verified_defaults_and_raw_empty_command_rejected(self):
        self.assertEqual(m.project_settings(PROJECT),m.EXPECTED_SETTINGS)
        without={k:v for k,v in PROJECT.items() if k not in ('rootDirectory','buildCommand','installCommand','outputDirectory','link')};m.project_settings(without)
        for key,value in [('rootDirectory','apps/web'),('buildCommand',''),('buildCommand','npm run build'),('installCommand',''),('outputDirectory','dist'),('framework','nextjs'),('nodeVersion','22.x'),('link',{'repo':'comminicationstation'}),('autoAssignCustomDomains',False),('autoAssignCustomDomains',None),('id','other'),('accountId','other'),('crons',None),('crons',{'definitions':[{'path':'/cron'}]}),('crons',{'definitions':[],'disabledAt':1})]:
            with self.subTest(key=key,value=value),self.assertRaises(RuntimeError):m.project_settings({**PROJECT,key:value})
        m.project_settings({**PROJECT,'autoAssignCustomDomains':False},False)
    def test_complete_domain_scope(self):
        m.domain_inventory(DOMAIN)
        cases=[{'domains':[],'pagination':{'next':None}},{**DOMAIN,'pagination':{'next':123}},{**DOMAIN,'pagination':None},{**DOMAIN,'domains':DOMAIN['domains']*2}]
        for field,value in [('name','other.com'),('projectId','other'),('verified',False),('redirect','other.com'),('gitBranch','main'),('customEnvironmentId','custom')]:
            cases.append({**DOMAIN,'domains':[{**DOMAIN['domains'][0],field:value}]})
        for case in cases:
            with self.subTest(case=case),self.assertRaises(RuntimeError):m.domain_inventory(case)
    def test_baseline_and_candidate_provenance_are_distinct(self):
        m.deployment_identity(BASELINE,m.BASELINE_ID);m.deployment_identity(CANDIDATE,NEW_ID,True)
        for sample,identity,isnew in [(BASELINE,m.BASELINE_ID,True),(CANDIDATE,NEW_ID,False),({**CANDIDATE,'id':'other'},NEW_ID,True),({**CANDIDATE,'target':'preview'},NEW_ID,True),({**CANDIDATE,'projectId':'other'},NEW_ID,True),({**CANDIDATE,'readyState':'BUILDING'},NEW_ID,True),({**CANDIDATE,'aliasError':{'code':'failed'}},NEW_ID,True)]:
            with self.subTest(sample=sample),self.assertRaises(RuntimeError):m.deployment_identity(sample,identity,isnew)
        for key in ('mccSourceCommit','mccSourceTree','mccSourceManifest'):
            value=copy.deepcopy(CANDIDATE);value['meta'][key]='wrong'
            with self.subTest(key=key),self.assertRaises(RuntimeError):m.deployment_identity(value,NEW_ID,True)
    def test_baseline_all_provenance_fields_required(self):
        for key in ('mccSourceCommit','mccSourceTree','mccSourceManifest'):
            value=copy.deepcopy(BASELINE);value['meta'][key]='wrong'
            with self.subTest(key=key),self.assertRaises(RuntimeError):m.deployment_identity(value,m.BASELINE_ID)
    def test_eight_checks_and_distinct_receipts(self):
        self.assertEqual(len(m.CI_RUNS),2);self.assertEqual(sum(len(x[2]) for x in m.CI_RUNS),8)
        self.assertEqual(len({x[0] for x in m.CI_RUNS}),2)
        for run_id,_,_ in m.CI_RUNS:
            api=FakeAPI();base=api.json
            def read(service,path,body=None):
                result=base(service,path,body)
                if f'/runs/{run_id}/jobs?' in path: result['jobs'][0]['conclusion']='failure'
                return result
            api.json=read
            with self.subTest(run_id=run_id),self.assertRaises(RuntimeError):m.verify_ci(api)
    def test_actual_rollback_gate_remains_closed(self):
        with patch.dict(os.environ,BASE_ENV,clear=True),self.assertRaises(RuntimeError):m.validate_operation('rollback',m.BASELINE_ID,NEW_ID)
    def test_combined_main_ancestry_gate_is_present(self):
        source=SCRIPT.read_text()
        self.assertIn('"--is-ancestor", CANDIDATE, "HEAD"',source)
        self.assertIn('"--is-ancestor", INTEGRATION_BASE, "HEAD"',source)
        self.assertIn('"diff", "--exit-code", CANDIDATE, "HEAD", "--", "apps/web"',source)
    def test_exact_manifest_and_remote_tree(self):
        source=records();files,manifest=m.validate_files(source)
        self.assertEqual(len(files),31);self.assertEqual(sum(x['size'] for x in manifest),344823)
        self.assertEqual(m.digest(manifest),m.MANIFEST_SHA256)
        self.assertEqual(subprocess.check_output(['git','-C',str(FIXTURE),'rev-parse','HEAD:apps/web'],text=True).strip(),m.WEB_TREE)
        for item, (_,_,source) in zip(files, sorted(records())):
            self.assertEqual(base64.b64decode(item['data'],validate=True),source)
    def test_exact_source_git_extraction_and_dirty_worktree_exclusion(self):
        with cwd(FIXTURE),patch.object(m,'CANDIDATE',FIXTURE_COMMIT),patch.dict(os.environ,{'GITHUB_RUN_ID':'12345'}):
            payload,manifest=m.source_payload()
            target=FIXTURE/'apps/web/src/pages/Today.tsx';old=target.read_bytes();extra=FIXTURE/'apps/web/.env.fake-local-only'
            try:
                target.write_bytes(b'changed worktree');extra.write_text('not real credentials\n')
                after,_=m.source_payload();self.assertEqual(after,payload)
            finally:target.write_bytes(old);extra.unlink()
            self.assertEqual(set(payload),{'name','project','target','files','meta'})
            self.assertLess(len(m.canonical(payload)),1_000_000)
            for key in ('gitMetadata','gitSource','projectSettings','env','deploymentId','withLatestCommit'):self.assertNotIn(key,payload)
    def test_wrong_tree_and_commit_fail(self):
        with cwd(FIXTURE),patch.object(m,'CANDIDATE',FIXTURE_COMMIT),patch.object(m,'WEB_TREE','wrong'),self.assertRaises(RuntimeError):m.source_payload()
        with cwd(FIXTURE),patch.object(m,'CANDIDATE','0'*40),self.assertRaises(subprocess.CalledProcessError):m.source_payload()
    def test_missing_modified_extra_forbidden_paths_and_modes_fail(self):
        clean=records();name,mode,data=clean[0]
        cases=[clean[:-1],clean+[("extra.ts","100644",b'hi')],[(name,mode,data+b'x')]+clean[1:]]
        for path in ('../bad','/bad','a/../bad','a\\bad','.env','node_modules/x','api/x','functions/x','supabase/x'):
            cases.append([(path,mode,data)]+clean[1:])
        for badmode in ('120000','160000','100755'):cases.append([(name,badmode,data)]+clean[1:])
        cases += [[(name,mode,b'x'*128_000)]+clean[1:],[(name,mode,b'version https://git-lfs.github.com/spec/v1\n')]+clean[1:],clean[:-1]+[clean[0]]]
        for case in cases:
            with self.subTest(first=case[0][0]),self.assertRaises(RuntimeError):m.validate_files(case)
    def test_wrong_manifest_fails(self):
        with patch.object(m,'MANIFEST_SHA256','wrong'),self.assertRaises(RuntimeError):m.validate_files(records())
    def test_ci_gate(self):
        m.verify_ci(FakeAPI())
        for field,value in [('head_sha','wrong'),('conclusion','failure'),('status','queued'),('path','other')]:
            api=FakeAPI();base=api.json
            def request(service,path,body=None,field=field,value=value):
                result=base(service,path,body)
                if '/jobs?' not in path:result[field]=value
                return result
            api.json=request
            with self.subTest(field=field),self.assertRaises(RuntimeError):m.verify_ci(api)
        api=FakeAPI();base=api.json
        def request(service,path,body=None):
            result=base(service,path,body)
            if '/jobs?' in path:result['jobs']=result['jobs'][:-1]
            return result
        api.json=request
        with self.assertRaises(RuntimeError):m.verify_ci(api)
    def test_later_or_uncertain_deployment_blocks_new_creation(self):
        api=FakeAPI();m.verify_no_later_deployment(api)
        api.later=[{'id':'dpl_Pending','state':'QUEUED'}]
        with self.assertRaises(RuntimeError):m.verify_no_later_deployment(api)
    def test_only_exact_terminal_failed_attempt_is_reconciled(self):
        for later in ([],[{'uid':'dpl_Other','state':'ERROR'}],[{'uid':m.RECONCILED_FAILURE_ID,'state':'BUILDING'}],[{'uid':m.RECONCILED_FAILURE_ID,'state':'ERROR'}]*2):
            api=FakeAPI();api.later=later
            with self.subTest(later=later),self.assertRaises(RuntimeError):m.verify_no_later_deployment(api)
        for field,value in [('readyState','READY'),('readyState','BUILDING'),('projectId','wrong'),('target','preview'),('createdAt',0),('meta',{})]:
            api=FakeAPI();base=api.deployment
            def deployment(identity):
                result=base(identity)
                if identity==m.RECONCILED_FAILURE_ID:result[field]=value
                return result
            api.deployment=deployment
            with self.subTest(field=field,value=value),self.assertRaises(RuntimeError):m.verify_no_later_deployment(api)
        api=FakeAPI();base=api.json
        def paged(service,path,body=None):
            result=base(service,path,body)
            if path.startswith('/v6/deployments?'):result['pagination']['next']=123
            return result
        api.json=paged
        with self.assertRaises(RuntimeError):m.verify_no_later_deployment(api)
        api=FakeAPI('rollback')
        with self.assertRaises(RuntimeError):m.verify_no_later_deployment(api)
    def test_domain_current_release_drift_fails(self):
        api=FakeAPI();m.verify_live(api,m.BASELINE_ID)
        with self.assertRaises(RuntimeError):m.verify_live(api,NEW_ID,True)
        api=FakeAPI('rollback');m.verify_live(api,NEW_ID,True)
        with self.assertRaises(RuntimeError):m.verify_live(api,'dpl_Unrelated',True)
    def run_main(self, api, operation='deploy'):
        env={**BASE_ENV,'OPERATION':operation,'CONFIRMATION':m.CANDIDATE if operation=='deploy' else m.BASELINE_ID,'RELEASE_DEPLOYMENT_ID':NEW_ID if operation=='rollback' else ''}
        with tempfile.TemporaryDirectory() as d,cwd(d),patch.dict(os.environ,env,clear=True),patch.object(m,'API',return_value=api),patch.object(m,'RELEASE_AUTHORIZATION','APPROVED'),patch.object(m,'ROLLBACK_AUTHORIZATION','APPROVED'),patch.object(m,'git',return_value=b''),patch.object(m.subprocess,'run'),patch.object(m,'source_payload',return_value=({'files':[]},[{}]*31)),patch.object(m,'smoke'),patch.object(m.time,'sleep'),contextlib.redirect_stdout(io.StringIO()):
            m.main()
    def test_inspect_has_zero_posts(self):
        api=FakeAPI();self.run_main(api,'inspect');self.assertEqual(api.posts,[])
    def test_successful_deploy_has_one_post(self):
        api=FakeAPI();self.run_main(api);self.assertEqual(len(api.posts),1);self.assertEqual(api.posts[0][0],'/v13/deployments')
    def test_successful_rollback_has_one_post_and_no_reenable(self):
        api=FakeAPI('rollback');self.run_main(api,'rollback');self.assertEqual(len(api.posts),1);self.assertIn('/rollback/',api.posts[0][0])
    def test_failures_and_timeouts_never_retry_or_rollback(self):
        for failure in ('uncertain','ERROR','CANCELED','CANCELLED','BUILDING','alias'):
            api=FakeAPI(failure=failure)
            with self.subTest(failure=failure),self.assertRaises(RuntimeError):self.run_main(api)
            self.assertEqual(len(api.posts),1)
    def test_transport_empty_201_rollback_success_and_create_fail_closed(self):
        class Response:
            status=201
            def __init__(self,raw):self.raw=raw
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self):return self.raw
        class Opener:
            def __init__(self,raw):self.raw=raw;self.calls=[]
            def open(self,request,timeout):self.calls.append(request);return Response(self.raw)
        with patch.dict(os.environ,{'VERCEL_TOKEN':'test-only-sentinel','GH_TOKEN':'test-only-sentinel'}):
            api=m.API();api.opener=Opener(b'')
            result=api.json('vercel',f'/v1/projects/{m.PROJECT}/rollback/{m.BASELINE_ID}',{})
            self.assertEqual(result,{});self.assertEqual(len(api.opener.calls),1)
            api.opener=Opener(b'')
            with self.assertRaises(RuntimeError):api.json('vercel','/v13/deployments',{'files':[]})
            self.assertEqual(len(api.opener.calls),1)
            api.opener=Opener(b'{"id":"dpl_NewApproved123"}')
            self.assertEqual(api.json('vercel','/v13/deployments',{'files':[]})['id'],NEW_ID)
            self.assertEqual(len(api.opener.calls),1)
    def test_transport_timeout_is_single_shot_and_redirect_refused(self):
        class Opener:
            calls=0
            def open(self,*args,**kwargs):self.calls+=1;raise TimeoutError()
        with patch.dict(os.environ,{'VERCEL_TOKEN':'test-only-sentinel','GH_TOKEN':'test-only-sentinel'}):
            api=m.API();api.opener=Opener()
            with self.assertRaises(RuntimeError):api.json('vercel','/v13/deployments',{'files':[]})
            self.assertEqual(api.opener.calls,1)
        with self.assertRaises(RuntimeError):m.NoRedirect().redirect_request(None,None,302,'redirect',{},'https://example.invalid')
    def test_no_backend_or_promotion_mutators(self):
        text=SCRIPT.read_text();self.assertNotIn('api.supabase',text);self.assertNotIn('/promote/',text)
        self.assertEqual(text.count('api.json("vercel", "/v13/deployments", payload)'),1)
        self.assertEqual(text.count('api.json("vercel", f"/v1/projects/{PROJECT}/rollback/{BASELINE_ID}", {})'),1)

if __name__=='__main__':unittest.main(verbosity=2)
