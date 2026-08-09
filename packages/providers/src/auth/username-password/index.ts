import type {
  AuthProvider,
  Credentials,
  FlowStep,
  FormGroup,
  LoginFlow,
  RendererSession,
} from '@jsxray/core';

const DEFAULT_LOGIN_ROUTE = '/login';
const USERNAME_FIELD = /\b(email|user(name)?|login|account)\b/i;

export const usernamePasswordAuth: AuthProvider = {
  axis: 'auth',
  id: 'username-password',
  priority: 10,
  capabilities: { sessionCheck: true },

  supports: () => true,

  /** §4 — `loginFlow` is this provider's script; without one, synthesize from `forms()`. */
  async login(
    session: RendererSession,
    credentials: Credentials,
    loginFlow: LoginFlow | null,
  ): Promise<void> {
    const start = loginFlow?.start ?? DEFAULT_LOGIN_ROUTE;
    await session.goto(start);
    await session.settle();

    if (loginFlow?.steps.length) {
      for (const step of loginFlow.steps) await replay(session, step, credentials);
      return;
    }

    const form = pickLoginForm(await session.forms());
    if (!form) {
      throw new Error(
        `no login form found at ${start}; declare config.loginFlow with explicit steps`,
      );
    }

    const password = form.controls.find((control) => control.type === 'password')!;
    const username =
      form.controls.find(
        (control) =>
          control.type === 'email' ||
          control.autocomplete === 'username' ||
          control.autocomplete === 'email',
      ) ??
      form.controls.find((control) =>
        USERNAME_FIELD.test(`${control.name ?? ''} ${control.label ?? ''}`),
      );

    if (!username) throw new Error(`login form at ${start} has no recognizable username field`);

    await session.fill(username.ref, credentials.username);
    await session.fill(password.ref, credentials.password);
    if (form.submit) await session.tap(form.submit.ref);
    await session.settle();
  },

  async isLoggedIn(session: RendererSession): Promise<boolean> {
    const forms = await session.forms();
    return !forms.some((form) =>
      form.controls.some((control) => control.type === 'password'),
    );
  },
};

async function replay(
  session: RendererSession,
  step: FlowStep,
  credentials: Credentials,
): Promise<void> {
  if ('goto' in step) {
    await session.goto(step.goto);
    await session.settle();
    return;
  }
  if ('fill' in step) {
    for (const [ref, value] of Object.entries(step.fill)) {
      await session.fill(ref, substitute(value, credentials));
    }
    return;
  }
  if ('tap' in step || 'submit' in step) {
    await session.tap('tap' in step ? step.tap : step.submit);
    await session.settle();
  }
}

function substitute(value: string, credentials: Credentials): string {
  return value
    .replace(/\{\{\s*username\s*\}\}/g, credentials.username)
    .replace(/\{\{\s*password\s*\}\}/g, credentials.password);
}

function pickLoginForm(forms: readonly FormGroup[]): FormGroup | null {
  return (
    forms.find((form) => form.controls.some((control) => control.type === 'password')) ?? null
  );
}
