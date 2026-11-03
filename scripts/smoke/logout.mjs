import { removeLocalAuth } from './Auth.mjs';
import { execute } from './Shared.mjs';

await execute(async () => {
  await removeLocalAuth();

  console.log('已清除本機 OAuth 登入檔案。遠端 OAuth Grant／Token 未因此撤銷。');
});
