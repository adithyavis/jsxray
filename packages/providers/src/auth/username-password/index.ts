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
      await confirm(session);
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
    await confirm(session);
  },

  async isLoggedIn(session: RendererSession): Promise<boolean> {
    const forms = await session.forms();
    return !forms.some((form) =>
      form.controls.some((control) => control.type === 'password'),
    );
  },
};

/**
 * §7.7 — a login that quietly failed is worse than one that loudly did. The flow
 * runs, nothing throws, and the crawl maps the login wall under the persona's name:
 * 51 screens of the logged-out app filed as "user", with no sign anything went
 * wrong. So the last step of logging in is checking that it happened.
 *
 * The password field is the evidence, and this is the one moment it is reliable —
 * the form is still on screen with its error on it. A page later there is no
 * password field anywhere and the same question has no answer.
 */
async function confirm(session: RendererSession): Promise<void> {
  if (await usernamePasswordAuth.isLoggedIn!(session)) return;
  throw new Error(
    `the login flow ran but a password field is still on screen at ${await session.url()}; ` +
      `the credentials were refused, or the flow needs another step`,
  );
}

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
    return;
  }
  // A login screen that arrives on a timer is settled long before it exists.
  if ('wait' in step) await new Promise((resolve) => setTimeout(resolve, step.wait));
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
