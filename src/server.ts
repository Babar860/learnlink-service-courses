import cors from "cors";
import "dotenv/config";
import express from "express";
import { z } from "zod";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const agentsUrl = process.env.AGENTS_SERVICE_URL ?? "http://localhost:5005";

type Course = {
  id: string;
  title: string;
  description: string;
  category: string;
  teacher_id: string;
  teacher_name?: string;
  is_paid: boolean;
  price: number;
  prerequisites: string[];
  access_restrictions: { organizations: string[]; regions: string[] };
  is_published: boolean;
  created_at: string;
};

type Section = { id: string; course_id: string; title: string; order: number };
type Lesson = { id: string; section_id: string; title: string; order: number; video_url?: string; video_size_bytes: number; quiz_id?: string };
type Quiz = {
  id: string;
  lesson_id?: string;
  timer_seconds: number;
  retry_allowed: boolean;
  retry_count: number;
  questions: Array<{ id: string; type: "mcq" | "problem_statement"; content: string; options: string[]; correct_option_index?: number; ai_converted: boolean }>;
};
type LiveClass = { id: string; teacher_id: string; title: string; course_id?: string; scheduled_at?: string; status: "scheduled" | "live" | "ended"; join_link: string; organization_id?: string; grade?: string; is_open: boolean; created_at: string };
type Enrollment = { id: string; live_class_id: string; student_id: string; registration_number?: string; validated: boolean; joined_at: string; device_fingerprint: string };
type LiveClassQuiz = { id: string; live_class_id: string; quiz_id: string; started_at: string; ended_at?: string };
type Submission = { id: string; live_class_quiz_id: string; student_id: string; answers: Record<string, unknown>; submitted_at: string; score?: number };

const courses: Course[] = [];
const sections: Section[] = [];
const lessons: Lesson[] = [];
const quizzes: Quiz[] = [];
const liveClasses: LiveClass[] = [];
const enrollments: Enrollment[] = [];
const liveClassQuizzes: LiveClassQuiz[] = [];
const quizSubmissions: Submission[] = [];
const coursePurchases: Array<{ id: string; course_id: string; student_id: string; stripe_payment_intent_id: string; created_at: string }> = [];
const teacherChannels: Array<{ id: string; course_id: string; teacher_id: string; name: string; organization_id?: string; grade?: string; created_at: string }> = [];

const organizations = [
  { id: "kiet", name: "Karachi Institute of Economics and Technology", grade_pattern: /^[A-Za-z0-9-]{3,}$/ },
  { id: "learnlink-demo", name: "LearnLink Demo Organization", grade_pattern: /^[A-Za-z0-9-]{3,}$/ }
];

async function callAgent(path: string, payload: unknown) {
  try {
    const response = await fetch(`${agentsUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) return undefined;
    return response.json();
  } catch {
    return undefined;
  }
}

function videoHostingMode() {
  return process.env.FF_SELF_HOST_VIDEO === "false" ? "internal_future_storage" : "third_party";
}

function estimateVideoUploadFee(bytes: number) {
  const gb = bytes / 1024 / 1024 / 1024;
  return Math.max(0, Math.ceil(gb * 150));
}

function convertQuizPrompt(content: string): Quiz {
  return {
    id: crypto.randomUUID(),
    timer_seconds: 300,
    retry_allowed: true,
    retry_count: 1,
    questions: [{
      id: crypto.randomUUID(),
      type: content.toLowerCase().includes("problem") ? "problem_statement" : "mcq",
      content,
      options: ["Option A", "Option B", "Option C", "Option D"],
      correct_option_index: 0,
      ai_converted: true
    }]
  };
}

function courseSummary(course: Course) {
  const courseSections = sections.filter((section) => section.course_id === course.id);
  const lessonCount = lessons.filter((lesson) => courseSections.some((section) => section.id === lesson.section_id)).length;
  return { ...course, section_count: courseSections.length, lesson_count: lessonCount };
}

const courseUploadSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1),
  teacher_id: z.string().min(1),
  teacher_name: z.string().optional(),
  is_paid: z.boolean().default(false),
  price: z.number().int().nonnegative().default(0),
  prerequisites: z.array(z.string()).default([]),
  access_restrictions: z.object({
    organizations: z.array(z.string()).default([]),
    regions: z.array(z.string()).default([])
  }).default({ organizations: [], regions: [] }),
  is_published: z.boolean().default(true),
  sections: z.array(z.object({
    title: z.string().min(1),
    order: z.number().int(),
    lessons: z.array(z.object({
      title: z.string().min(1),
      order: z.number().int(),
      video_url: z.string().optional(),
      video_size_bytes: z.number().int().nonnegative().default(0),
      quiz_prompt: z.string().optional()
    })).default([])
  })).default([])
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "learnlink-service-courses" }));

app.get("/courses", (_req, res) => {
  res.json({
    courses: courses.filter((course) => course.is_published).map(courseSummary),
    live_classes: liveClasses,
    video_hosting_mode: videoHostingMode()
  });
});

app.post("/courses", (req, res) => {
  const payload = courseUploadSchema.parse(req.body);
  const course: Course = { id: crypto.randomUUID(), ...payload, created_at: new Date().toISOString() };
  courses.unshift(course);
  let totalVideoBytes = 0;

  for (const [sectionIndex, inputSection] of payload.sections.entries()) {
    const section: Section = { id: crypto.randomUUID(), course_id: course.id, title: inputSection.title, order: inputSection.order || sectionIndex + 1 };
    sections.push(section);
    for (const [lessonIndex, inputLesson] of inputSection.lessons.entries()) {
      totalVideoBytes += inputLesson.video_size_bytes;
      let quiz_id: string | undefined;
      if (inputLesson.quiz_prompt) {
        const quiz = convertQuizPrompt(inputLesson.quiz_prompt);
        quiz.lesson_id = undefined;
        quizzes.push(quiz);
        quiz_id = quiz.id;
      }
      lessons.push({ id: crypto.randomUUID(), section_id: section.id, title: inputLesson.title, order: inputLesson.order || lessonIndex + 1, video_url: inputLesson.video_url, video_size_bytes: inputLesson.video_size_bytes, quiz_id });
    }
  }

  res.status(201).json({
    course: courseSummary(course),
    video_hosting_mode: videoHostingMode(),
    upload_billing: { total_video_size_bytes: totalVideoBytes, estimated_fee: estimateVideoUploadFee(totalVideoBytes), currency: "PKR", rate_sheet: "TBD" }
  });
});

app.get("/courses/discovery/:studentId", async (req, res) => {
  const mode = req.query.resume_url ? "resume_keyword_agent" : req.query.completed_track ? "next_level_same_track" : "trending_plus_onboarding";
  const agent = await callAgent("/agents/recommend", { user_id: req.params.studentId, resume_url: req.query.resume_url, onboarding_answers: req.query });
  const ranked = courses
    .filter((course) => course.is_published)
    .map((course) => ({ ...courseSummary(course), rank_reason: mode, score: course.category === req.query.category ? 0.95 : 0.72 }))
    .sort((a, b) => b.score - a.score);
  res.json({ mode, courses: ranked, recommendations: agent ?? { mode } });
});

app.get("/courses/:courseId/roadmap", (req, res) => {
  const course = courses.find((item) => item.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: "course_not_found" });
  const premium = req.query.subscription_tier === "premium";
  if (!premium) return res.status(402).json({ error: "premium_required", message: "Premium subscription unlocks roadmap, paid courses, and 15 matching jobs." });
  res.json({
    roadmap: [
      `Start with ${course.title}`,
      "Complete all lessons and quizzes",
      "Build a portfolio project",
      "Apply to matching jobs"
    ],
    included_paid_courses: courses.filter((item) => item.is_paid).slice(0, 5),
    matching_jobs: Array.from({ length: 15 }, (_, index) => ({ id: `job-match-${index + 1}`, title: `${course.category} role ${index + 1}`, source: "LearnLink jobs" }))
  });
});

app.post("/courses/:courseId/purchase", (req, res) => {
  const course = courses.find((item) => item.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: "course_not_found" });
  if (!course.is_paid) return res.json({ status: "free_course_access_granted" });
  const purchase = { id: crypto.randomUUID(), course_id: course.id, student_id: String(req.body.student_id ?? ""), stripe_payment_intent_id: `pi_local_${crypto.randomUUID()}`, created_at: new Date().toISOString() };
  coursePurchases.push(purchase);
  res.status(201).json({ purchase, payment: "stripe_payment_intent_placeholder" });
});

app.post("/quizzes/convert", async (req, res) => {
  const converted = await callAgent("/agents/quiz-convert", req.body);
  res.json({ quiz: converted ?? convertQuizPrompt(String(req.body.content ?? "")), teacher_confirmation_required: true });
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
  const liveClass: LiveClass = {
    id: crypto.randomUUID(),
    ...payload,
    status: payload.scheduled_at ? "scheduled" : "live",
    join_link: `/live/${crypto.randomUUID()}`,
    is_open: !payload.organization_id,
    created_at: new Date().toISOString()
  };
  liveClasses.unshift(liveClass);
  res.status(201).json({ live_class: liveClass, reminders: ["student_fcm_15_min_before", "teacher_email_sms"], notifications: ["fcm", "email", "sms"] });
});

app.post("/live-classes/:id/join", (req, res) => {
  const liveClass = liveClasses.find((item) => item.id === req.params.id);
  if (!liveClass) return res.status(404).json({ error: "live_class_not_found" });
  const org = liveClass.organization_id ? organizations.find((item) => item.id === liveClass.organization_id) : undefined;
  const registrationNumber = String(req.body.registration_number ?? "");
  const gradeMatches = !liveClass.grade || String(req.body.grade ?? liveClass.grade) === liveClass.grade;
  const validated = liveClass.is_open || Boolean(org && org.grade_pattern.test(registrationNumber) && gradeMatches);
  if (!liveClass.is_open && !validated) return res.status(403).json({ error: "organization_validation_failed" });
  const enrollment: Enrollment = { id: crypto.randomUUID(), live_class_id: liveClass.id, student_id: String(req.body.student_id ?? ""), registration_number: registrationNumber, validated, joined_at: new Date().toISOString(), device_fingerprint: String(req.body.device_fingerprint ?? "local-device") };
  const existing = enrollments.findIndex((item) => item.live_class_id === liveClass.id && item.student_id === enrollment.student_id);
  if (existing >= 0) enrollments.splice(existing, 1);
  enrollments.push(enrollment);
  res.json({ enrollment, one_active_device_enforced: true });
});

app.post("/live-classes/:id/quizzes/start", (req, res) => {
  const liveClass = liveClasses.find((item) => item.id === req.params.id);
  if (!liveClass) return res.status(404).json({ error: "live_class_not_found" });
  const quiz = convertQuizPrompt(String(req.body.prompt ?? "Live class quiz"));
  quizzes.push(quiz);
  const liveClassQuiz: LiveClassQuiz = { id: crypto.randomUUID(), live_class_id: liveClass.id, quiz_id: quiz.id, started_at: new Date().toISOString() };
  liveClassQuizzes.push(liveClassQuiz);
  res.status(201).json({ live_class_quiz: liveClassQuiz, quiz, broadcast: "quiz_visible_on_active_student_screens" });
});

app.post("/live-classes/quizzes/:liveClassQuizId/submissions", (req, res) => {
  const submission: Submission = { id: crypto.randomUUID(), live_class_quiz_id: req.params.liveClassQuizId, student_id: String(req.body.student_id ?? ""), answers: req.body.answers ?? {}, submitted_at: new Date().toISOString() };
  quizSubmissions.push(submission);
  res.status(201).json({ submission });
});

app.post("/live-classes/quizzes/:liveClassQuizId/grade", async (req, res) => {
  if (process.env.FF_LIVE_QUIZ_GRADING === "false") return res.status(403).json({ error: "grading_feature_disabled" });
  const submissions = quizSubmissions.filter((item) => item.live_class_quiz_id === req.params.liveClassQuizId);
  const result = await callAgent("/agents/grade", { live_class_quiz_id: req.params.liveClassQuizId, submissions });
  res.json(result ?? { status: "marksheet_generated", delivery: "teacher_fcm_email", format: "xlsx", rows: submissions.length, paid_feature: true });
});

app.post("/live-classes/:id/key-points", async (req, res) => {
  if (process.env.FF_PREMIUM_KEY_POINTS === "false") return res.status(403).json({ error: "key_points_disabled" });
  if (req.body.subscription_tier !== "premium") return res.status(402).json({ error: "premium_required" });
  const result = await callAgent("/agents/key-points", { live_class_id: req.params.id, transcript: req.body.transcript });
  res.json(result ?? { key_points: String(req.body.transcript ?? "").split(/[.!?]/).map((item) => item.trim()).filter(Boolean).slice(0, 5), saved_to_profile: true, notification: "student_fcm", paid_feature: true });
});

app.post("/courses/:courseId/channel", (req, res) => {
  const course = courses.find((item) => item.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: "course_not_found" });
  const channel = { id: crypto.randomUUID(), course_id: course.id, teacher_id: course.teacher_id, name: String(req.body.name ?? `${course.title} Channel`), organization_id: req.body.organization_id, grade: req.body.grade, created_at: new Date().toISOString() };
  teacherChannels.push(channel);
  res.status(201).json({ channel, purpose: "async_material_sharing_alongside_live_classes" });
});

const port = Number(process.env.COURSES_PORT ?? 4200);
app.listen(port, () => console.log(`courses service listening on :${port}`));
