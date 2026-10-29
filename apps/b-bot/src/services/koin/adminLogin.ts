interface KoinAdminLoginResponse {
  token: string;
}

/** 어느 코인에 붙을지는 부르는 쪽이 정한다. 채널로 이미 정해져 있어 기본값을 둘 이유가 없다. */
export async function loginKoinAdmin({
  baseURL,
  email,
  password,
}: {
  baseURL: string;
  email: string;
  password: string;
}): Promise<string> {
  const response = await $fetch<KoinAdminLoginResponse>('admin/user/login', {
    baseURL,
    method: 'POST',
    body: {
      email,
      password,
    },
  });

  if (typeof response.token !== 'string' || response.token.length === 0) {
    throw new Error('KOIN 관리자 로그인 응답에 액세스 토큰이 없습니다.');
  }

  return response.token;
}
