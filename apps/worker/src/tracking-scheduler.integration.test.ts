import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { runMigrations } from '@nextdoo/db';
import { requireTestDatabase } from '../../../tests/database';
await requireTestDatabase();

it('standalone scheduler recovers an interrupted calculation after a real worker crash without losing queue or history',async()=>{
 const source=process.env.DATABASE_URL!,name=`tracking_crash_${randomUUID().replaceAll('-','')}`;
 const url=new URL(source);url.pathname=`/${name}`;
 const admin=postgres(source,{max:1,onnotice:()=>{}});
 let created=false,connection:ReturnType<typeof postgres>|undefined,child:ChildProcess|undefined;
 let output='';
 const start=()=>{
  const worker=spawn(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),fileURLToPath(new URL('./index.ts',import.meta.url))],{
   env:{...process.env,DATABASE_URL:url.toString(),SMTP_URL:'',APP_URL:'http://localhost:3100'},stdio:['ignore','pipe','pipe'],
  });
  worker.stdout!.on('data',data=>output+=String(data));worker.stderr!.on('data',data=>output+=String(data));return worker;
 };
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;
  expect(await runMigrations(url.toString())).toContain('0013_durable_tracking.sql');expect(await runMigrations(url.toString())).toEqual([]);
  connection=postgres(url.toString(),{max:2,onnotice:()=>{}});const db=connection;
  const userId=randomUUID(),workspaceId=randomUUID(),taskId=randomUUID(),eventId=randomUUID();
  await db.begin(async tx=>{
   await tx`insert into users(id,email,password_hash) values(${userId},${userId+'@test.local'},'test')`;
   await tx`insert into workspaces(id,owner_id,name) values(${workspaceId},${userId},'Crash acceptance')`;
   await tx`insert into tasks(id,workspace_id,title) values(${taskId},${workspaceId},'Crash-safe tracking')`;
   await tx`insert into tracking_events(id,workspace_id,task_id,type,occurred_at,idempotency_key) values(${eventId},${workspaceId},${taskId},'TASK_CREATED',now(),${eventId})`;
   await tx`insert into outbox(id,workspace_id,event_type,entity_type,entity_id) values(${randomUUID()},${workspaceId},'task.created','task',${taskId})`;
  });
  await db.unsafe(`CREATE FUNCTION tracking_crash_gate() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(30); RETURN NEW; END; $$ LANGUAGE plpgsql;
   CREATE TRIGGER tracking_crash_gate AFTER INSERT ON tracking_results FOR EACH ROW EXECUTE FUNCTION tracking_crash_gate();`);
  child=start();
  await expect.poll(async()=>{
   const rows=await db`select pid from pg_stat_activity where datname=${name} and wait_event='PgSleep'`;
   if(child?.exitCode!==null)throw new Error('Worker exited before calculation: '+output);
   return rows.length;
  },{timeout:15000,interval:50}).toBe(1);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;
  // PostgreSQL's statement deadline bounds a backend still detecting disconnect.
  await expect.poll(async()=>(await db`select pid from pg_stat_activity where datname=${name} and wait_event='PgSleep'`).length,{timeout:12000,interval:100}).toBe(0);
  expect(await db`select id from tracking_results`).toHaveLength(0);
  expect(await db`select outbox_id from tracking_outbox_receipts`).toHaveLength(1);
  const [pending]=await db`select queued_revision,acknowledged_revision,evaluated_revision,attempts,claim_token from tracking_jobs where task_id=${taskId}`;
  expect(pending!.queued_revision).toBeGreaterThan(pending!.acknowledged_revision);expect(pending!.evaluated_revision).toBe(0);expect(pending!.attempts).toBe(1);expect(pending!.claim_token).not.toBeNull();
  // Advance the durable lease clock to model downtime without a two-minute sleep.
  await db`update tracking_jobs set lease_expires_at=clock_timestamp()-interval '2 minutes' where task_id=${taskId}`;
  await db.unsafe('DROP TRIGGER tracking_crash_gate ON tracking_results; DROP FUNCTION tracking_crash_gate();');
  child=start();
  await expect.poll(async()=>(await db`select id from tracking_results where superseded_at is null`).length,{timeout:15000,interval:50}).toBe(1);
  expect(await db`select id from tracking_results`).toHaveLength(1);
  const [done]=await db`select revision,acknowledged_revision,evaluated_revision,attempts from tracking_jobs where task_id=${taskId}`;
  expect(done!.acknowledged_revision).toBe(done!.revision);expect(done!.evaluated_revision).toBe(done!.revision);expect(done!.attempts).toBe(0);
  expect(output).toContain('worker.started');
 }finally{
  if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}
  if(connection)await connection.end({timeout:1});
  if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end({timeout:1});
 }
},60000);
