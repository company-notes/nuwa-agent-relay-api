import { browserLogin } from './Auth.mjs';
import { execute } from './Shared.mjs';

await execute(async () => {
  const side = process.argv[2] || 'a';

  if (!['a', 'b'].includes(side)) {
    throw new Error('Usage: npm run smoke:login -- a|b');
  }

  await browserLogin(side);
});
