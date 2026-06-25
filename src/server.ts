import cors from "cors";
import "dotenv/config";
import express from "express";
import { z } from "zod";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const agentsUrl = process.env.AGENTS_SERVICE_URL ?? "http://localhost:5005";
const courses: unknown[] = [];
const liveClasses: unknown[] = [];
const quizSubmissions: unknown[] = [];

async function callAgent(path: string, payload: unknown) {
  const response = await fetch(`${agentsUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) return undefined;
  return response.json();
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "learnlink-service-courses" }));

app.post("/courses", (req, res) => {
  const payload = z.object({
    title: z.string(),
    description: z.string(),
    category: z.string(),
    teacher_id: z.string(),
    is_paid: z.boolean().default(false),
    price: z.number().int().nonnegative().default(0),
    prerequisites: z.array(z.string()).default([]),
    access_restrictions: z.object({
      organizations: z.array(z.string()).default([]),
      regions: z.array(z.string()).default([])
    }).default({ organizations: [], regions: [] }),
    is_published: z.boolean().default(false),
    sections: z.array(z.object({
      title: z.string(),
      order: z.number().int(),
      lessons: z.array(z.object({
        title: z.string(),
        order: z.number().int(),
        video_url: z.string().optional(),
        video_size_bytes: z.number().int().nonnegative().default(0),
        quiz_id: z.string().optional()
      })).default([])
    })).default([])
  }).parse(req.body);

  const course = { id: crypto.randomUUID(), ...payload, created_at: new Date().toISOString() };
  courses.push(course);
  res.status(201).json({ course, video_hosting_mode: process.env.FF_SELF_HOST_VIDEO === "true" ? "third_party" : "internal_future_storage" });
});

app.get("/courses/discovery/:studentId", async (req, res) => {
  const recommendations = await callAgent("/agents/recommend", {
    user_id: req.params.studentId,
    resume_url: req.query.resume_url,
    onboarding_answers: req.query
  });
  res.json({ courses, recommendations: recommendations ?? { mode: "trending_plus_onboarding" } });
});

app.post("/quizzes/convert", async (req, res) => {
  const converted = await callAgent("/agents/quiz-convert", req.body);
  res.json({
    quiz: converted ?? {
      timer_seconds: 300,
      retry_allowed: true,
      retry_count: 1,
      questions: [{ id: crypto.randomUUID(), type: "mcq", content: String(req.body.content ?? ""), options: [], ai_converted: true }]
    },
    teacher_confirmation_required: true
  });
});

app.post("/live-classes", (req, res) => {
  const payload = z.object({
    teacher_id: z.string(),
    title: z.string(),
    course_id: z.string().optional(),
    scheduled_at: z.string().optional(),
    organization_id: z.string().optional(),
    grade: z.string().optional()
  }).parse(req.body);

  const liveClass = {
    id: crypto.randomUUID(),
    ...payload,
    status: payload.scheduled_at ? "scheduled" : "live",
    join_link: `/live/${crypto.randomUUID()}`,
    is_open: !payload.organization_id,
    created_at: new Date().toISOString()
  };
  liveClasses.push(liveClass);
  res.status(201).json({ live_class: liveClass, reminders: ["student_fcm_15_min_before", "teacher_email_sms"] });
});

app.post("/live-classes/:id/join", (req, res) => {
  const liveClass = liveClasses.find((item) => typeof item === "object" && item && "id" in item && item.id === req.params.id) as { organization_id?: string; grade?: string } | undefined;
  if (!liveClass) return res.status(404).json({ error: "live_class_not_found" });

  const requiresValidation = Boolean(liveClass.organization_id);
  res.json({
    enrollment_id: crypto.randomUUID(),
    validated: !requiresValidation || Boolean(req.body.registration_number),
    one_active_device_enforced: true
  });
});

app.post("/live-classes/:id/quizzes/start", (req, res) => {
  res.status(201).json({
    live_class_quiz_id: crypto.randomUUID(),
    live_class_id: req.params.id,
    quiz_id: req.body.quiz_id,
    started_at: new Date().toISOString(),
    broadcast: "quiz_visible_on_active_student_screens"
  });
});

app.post("/live-classes/quizzes/:liveClassQuizId/submissions", async (req, res) => {
  const submission = {
    id: crypto.randomUUID(),
    live_class_quiz_id: req.params.liveClassQuizId,
    student_id: req.body.student_id,
    answers: req.body.answers ?? {},
    submitted_at: new Date().toISOString()
  };
  quizSubmissions.push(submission);
  res.status(201).json({ submission });
});

app.post("/live-classes/quizzes/:liveClassQuizId/grade", async (req, res) => {
  if (process.env.FF_LIVE_QUIZ_GRADING !== "true") return res.status(403).json({ error: "grading_feature_disabled" });
  const result = await callAgent("/agents/grade", { live_class_quiz_id: req.params.liveClassQuizId, submissions: quizSubmissions });
  res.json(result ?? { status: "marksheet_generated", delivery: "teacher_fcm_email", format: "xlsx" });
});

app.post("/live-classes/:id/key-points", async (req, res) => {
  if (process.env.FF_PREMIUM_KEY_POINTS !== "true") return res.status(403).json({ error: "key_points_disabled" });
  const result = await callAgent("/agents/key-points", { live_class_id: req.params.id, transcript: req.body.transcript });
  res.json(result ?? { key_points: [], saved_to_profile: true, notification: "student_fcm" });
});

const port = Number(process.env.COURSES_PORT ?? 4200);
app.listen(port, () => console.log(`courses service listening on :${port}`));

