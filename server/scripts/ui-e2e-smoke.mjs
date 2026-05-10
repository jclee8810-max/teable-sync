#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { chromium } from 'playwright';

const APP_URL = (process.env.UI_E2E_BASE || 'http://127.0.0.1:3101').replace(/\/+$/, '');
const EMAIL = process.env.UI_E2E_EMAIL || 'ui-e2e-owner@test.local';
const PASSWORD = process.env.UI_E2E_PASSWORD || 'ui-e2e-pass';
const REPORT_DIR = join(process.cwd(), 'server', 'data', 'reports');
const startedAt = new Date();
const results = [];

function record(ok, name, detail = '') {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
}

async function expectVisible(page, text, name) {
  const locator = page.getByText(text, { exact: false }).first();
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  record(true, name);
}

async function clickNav(page, label) {
  await page.locator('.sidebar-nav').getByRole('button', { name: new RegExp(label) }).click();
}

async function closeOpenDialog(page) {
  for (let i = 0; i < 3; i += 1) {
    const visibleDialogs = page.locator('[role="dialog"]:visible');
    if (!(await visibleDialogs.count())) return;
    const closeButton = page.locator('.el-dialog__headerbtn:visible').last();
    if (await closeButton.count()) await closeButton.click({ force: true });
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
}

async function run() {
  const browser = await chromium.launch({ headless: process.env.UI_E2E_HEADLESS !== 'false' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  page.setDefaultTimeout(12000);
  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await page.getByPlaceholder('your@email.com').fill(EMAIL);
    await page.getByPlaceholder('输入密码').fill(PASSWORD);
    await page.locator('form.auth-form').getByRole('button', { name: '登录', exact: true }).click();
    await page.getByText('同步任务', { exact: true }).first().waitFor({ state: 'visible' });
    await expectVisible(page, 'UI E2E Failure Guidance', 'task list loads seeded failure task');

    const realtimeCard = page.locator('.task-card').filter({ hasText: 'UI E2E Realtime Disabled Run' }).first();
    const realtimeRunButton = realtimeCard.getByRole('button', { name: /^同步$/ });
    await realtimeRunButton.waitFor({ state: 'visible' });
    record(await realtimeRunButton.isDisabled(), 'realtime task manual sync button is disabled');

    const failureCard = page.locator('.task-card').filter({ hasText: 'UI E2E Failure Guidance' }).first();
    await failureCard.getByRole('button', { name: /打开失败批次|失败批次|编辑设置|去处理|检查映射|查看详情/ }).first().click();
    await page.getByRole('dialog').filter({ hasText: '失败批次恢复' }).first().waitFor({ state: 'visible' });
    record(true, 'task guidance action opens failure recovery');
    await closeOpenDialog(page);

    await clickNav(page, '观测告警');
    await expectVisible(page, '活跃告警', 'observability page loads');
    await expectVisible(page, '建议：', 'observability shows suggested action');
    await page.locator('.alert-row').filter({ hasText: 'UI E2E Failure Guidance' }).first().getByRole('button', { name: /编辑设置|任务详情|失败批次|去处理/ }).first().click();
    await page.waitForFunction(() => document.body.innerText.includes('UI E2E Failure Guidance') && document.body.innerText.includes('同步任务'));
    record(true, 'observability resolution opens task area');

    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await expectVisible(page, 'UI E2E Failure Guidance', 'task page reload keeps session');
    await clickNav(page, '数据源');
    await expectVisible(page, 'UI E2E Ready SQL', 'connections page shows ready source');
    await clickNav(page, '同步任务');
    await page.getByRole('button', { name: '新建任务' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: '新建同步任务' }).first();
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('.el-form-item').filter({ hasText: '源连接' }).locator('.el-select').click();
    await page.waitForTimeout(300);
    const sourceDropdownText = await page.locator('.el-select-dropdown:visible').last().innerText();
    record(!sourceDropdownText.includes('UI E2E Untested SQL') && !sourceDropdownText.includes('UI E2E Failed SQL'), 'untested and failed sources are hidden from source select');
    await closeOpenDialog(page);

    await browser.close();
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

let exitCode = 0;
try {
  await run();
} catch (err) {
  exitCode = 1;
  results.push({ ok: false, name: 'UI E2E smoke', detail: err.message });
}

mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = join(REPORT_DIR, `ui-e2e-smoke_${startedAt.toISOString().replace(/[:.]/g, '-')}.md`);
const lines = [
  '# Teable Sync UI E2E Smoke',
  '',
  `- Started: ${startedAt.toISOString()}`,
  `- Finished: ${new Date().toISOString()}`,
  `- Base URL: ${APP_URL}`,
  `- Status: ${exitCode === 0 ? 'PASS' : 'FAIL'}`,
  '',
  '| Step | Status | Detail |',
  '| --- | --- | --- |',
  ...results.map((item) => `| ${item.name} | ${item.ok ? 'PASS' : 'FAIL'} | ${(item.detail || '').replace(/\|/g, '/') || '-'} |`),
  '',
];
writeFileSync(reportPath, lines.join('\n'), 'utf8');
console.log(reportPath);
process.exit(exitCode);
