import { test, expect } from "@playwright/test";

test("simultaneous first-visit tabs share one learner and react to an intentional replacement", async ({
  page,
  context,
}) => {
  const second = await context.newPage();
  let learnerRequests = 0;
  context.on("request", (request) => {
    if (request.url().endsWith("/api/learners") && request.method() === "POST")
      learnerRequests++;
  });
  await Promise.all([page.goto("/"), second.goto("/")]);
  await expect(
    page.getByRole("heading", { name: "첫 학습을 시작해 보세요." }),
  ).toBeVisible();
  await expect(
    second.getByRole("heading", { name: "첫 학습을 시작해 보세요." }),
  ).toBeVisible();
  expect(learnerRequests).toBe(1);
  const firstToken = await page.evaluate(() =>
    localStorage.getItem("recall.learnerToken"),
  );
  expect(firstToken).toBeTruthy();
  expect(
    await second.evaluate(() => localStorage.getItem("recall.learnerToken")),
  ).toBe(firstToken);
  const replacementResponse = await page.request.post("/api/learners", {
    data: {},
  });
  expect(replacementResponse.ok()).toBeTruthy();
  const replacement = await replacementResponse.json();
  await second.evaluate(
    (token) => localStorage.setItem("recall.learnerToken", token),
    replacement.token,
  );
  await expect(page.getByText(/다른 탭에서 학습 키가 변경되어/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "첫 학습을 시작해 보세요." }),
  ).toBeVisible();
});

test("real server: DEMO → quiz feedback → confirmed edit and delete", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "다시 만나면, 더 오래 기억해요." }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("recall.learnerToken")),
    )
    .toBeTruthy();
  await page.getByRole("button", { name: "＋ 학습 자료 추가" }).click();
  await expect(page.getByText("별도의 고정 데모 예제")).toBeVisible();

  const demoRequest = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/jobs") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "고정 데모 문제 만들기 →" }).click();
  const demo = await demoRequest;
  expect(demo.status()).toBe(202);
  expect(demo.request().postDataJSON()).toEqual({ mode: "DEMO" });
  await expect(page.getByRole("button", { name: "퀴즈 풀기 →" })).toBeVisible();
  await page.getByRole("button", { name: "퀴즈 풀기 →" }).click();

  const questionText = page.locator(".question-text");
  await expect(questionText).toBeVisible();
  const originalQuestion = await questionText.innerText();
  await expect(page.locator(".feedback")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "답안 제출" })).toBeDisabled();
  await page.getByRole("radio").first().check();
  const answerRequest = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/attempts") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "답안 제출" }).click();
  const submission = await answerRequest;
  expect(submission.ok()).toBeTruthy();
  const answer = await submission.json();
  const payload = submission.request().postDataJSON();
  expect(answer.box).toBe(1);
  const tomorrow = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + 86_400_000));
  expect(answer.dueDate).toBe(tomorrow);
  expect(answer.explanation).toBeTruthy();
  expect(payload.idempotencyKey).toBeTruthy();
  await expect(page.locator(".feedback")).toBeVisible();
  await expect(page.locator(".feedback .explanation")).toHaveText(
    answer.explanation,
  );
  await expect(page.locator(".feedback")).toContainText("현재 1단계");
  await expect(page.locator(".feedback")).toContainText("다음 복습");
  await expect(page.getByRole("radio").first()).toBeDisabled();

  await page.getByRole("button", { name: "지금까지의 결과" }).click();
  await expect(
    page.getByRole("heading", { name: "이번 퀴즈 결과" }),
  ).toBeVisible();
  await expect(page.locator(".session-score")).toContainText("/ 1 정답");
  await page.getByRole("link", { name: "오늘의 복습" }).click();
  await expect(
    page.getByText(/첫 풀이의 정오답과 무관하게 1단계·내일 복습/),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "지금 복습할 문제가 없어요" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "문제 보관함" }).click();
  const originalCard = page
    .locator("article.card")
    .filter({
      has: page.getByRole("heading", { name: originalQuestion, exact: true }),
    });
  await expect(originalCard).toHaveCount(1);
  await originalCard.getByRole("button", { name: "수정", exact: true }).click();
  const editedText = `브라우저 검증 수정 문제 ${Date.now()}`;
  await page
    .getByRole("textbox", { name: "문제", exact: true })
    .fill(editedText);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("기존 풀이 기록과 복습 일정이 초기화");
    await dialog.accept();
  });
  const editRequest = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/questions/${payload.questionId}`) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "초기화 확인 후 저장" }).click();
  expect((await editRequest).ok()).toBeTruthy();
  await expect(
    page.getByText(
      "문제가 수정되었습니다. 기존 풀이·복습 기록은 초기화되었습니다.",
    ),
  ).toBeVisible();
  const editedCard = page
    .locator("article.card")
    .filter({
      has: page.getByRole("heading", { name: editedText, exact: true }),
    });
  await expect(editedCard).toHaveCount(1);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("삭제할까요");
    await dialog.accept();
  });
  const deleteRequest = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/questions/${payload.questionId}`) &&
      response.request().method() === "DELETE",
  );
  await editedCard.getByRole("button", { name: "삭제", exact: true }).click();
  expect((await deleteRequest).ok()).toBeTruthy();
  await expect(page.getByText("문제가 삭제되었습니다.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: editedText, exact: true }),
  ).toHaveCount(0);
});
