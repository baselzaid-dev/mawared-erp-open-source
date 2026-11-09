import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

describe('POST /api/v1/ai/chat (Gemini proxy)', () => {
  it('rejects unauthenticated calls', async () => {
    const app = makeApp(makeFakePrisma(), {}, { chat: async () => 'x' });
    const res = await request(app).post('/api/v1/ai/chat').send({ message: 'مرحبا' });
    expect(res.status).toBe(401);
  });

  it('rejects an empty message with a validation error', async () => {
    const app = makeApp(makeFakePrisma(), {}, { chat: async () => 'x' });
    const token = tokenFor();
    const res = await request(app)
      .post('/api/v1/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
  });

  it('returns 503 when no AI provider is configured (no key on server)', async () => {
    const app = makeApp(makeFakePrisma(), {}, null);
    const token = tokenFor();
    const res = await request(app)
      .post('/api/v1/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'مرحبا' });
    expect(res.status).toBe(503);
  });

  it('forwards the message to the provider and returns { reply }', async () => {
    const chat = vi.fn().mockResolvedValue('أهلاً بك! كيف أساعدك؟');
    const app = makeApp(makeFakePrisma(), {}, { chat });
    const token = tokenFor();

    const res = await request(app)
      .post('/api/v1/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'كم عدد الموظفين؟' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('أهلاً بك! كيف أساعدك؟');
    expect(chat).toHaveBeenCalledWith('كم عدد الموظفين؟');
  });

  it('maps provider failures to a structured 502 error', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('provider down'));
    const app = makeApp(makeFakePrisma(), {}, { chat });
    const token = tokenFor();

    const res = await request(app)
      .post('/api/v1/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'سؤال' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('AIProviderError');
  });
});

describe('GET /healthz', () => {
  it('returns ok without auth, DB, or secrets', async () => {
    const app = makeApp(makeFakePrisma());
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
