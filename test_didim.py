#!/usr/bin/env python3
"""디딤 main API 회귀 테스트. Python 3.11+.

레포 루트에 이 파일을 놓고 실행:
    python test_didim.py
다른 위치에서 실행:
    python test_didim.py --repo C:/Users/you/Documents/didim

임시 SQLite/업로드 폴더 및 가짜 계정을 사용한다. 외부 AI 호출 없음.
HTTP API와 실제 인증/DB 로직을 TestClient로 검사한다.
프런트엔드, 실제 Claude 응답 품질, 운영 Postgres/Storage는 검사하지 않는다.
기준: Lee-sangyul/didim main 229e293f9caf6f4b445747a05899c1df0204673c
"""
import argparse
import importlib
import json
import os
import shutil
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parent,
                        help='backend/app/main.py가 있는 레포 루트')
    args = parser.parse_args()
    root = args.repo.resolve()
    backend = root / 'backend'
    if not (backend / 'app' / 'main.py').is_file():
        parser.error('레포 루트를 찾을 수 없습니다. --repo 경로를 지정하세요.')
    if any(name == 'app' or name.startswith('app.') for name in sys.modules):
        parser.error('이미 app 모듈이 로드됐습니다. 별도 Python 프로세스로 실행하세요.')
    sys.path.insert(0, str(backend))

    with tempfile.TemporaryDirectory(prefix='didim-test-') as temporary:
        work = Path(temporary)
        test_env = {
            'APP_ENV': 'test',
            'DATABASE_URL': 'sqlite:///' + (work / 'test.db').as_posix(),
            'UPLOAD_DIR': str(work / 'uploads'),
            'DEMO_MODE': 'true',
            'ANTHROPIC_API_KEY': '',
            'COOKIE_SECURE': 'false',
            'MAX_UPLOAD_MB': '1',
            'SESSION_SECRET': 'test-only-secret',
            'LEGAL_CITATIONS_ENABLED': 'false',
            'LAW_API_OC': '',
            'SUPABASE_URL': '',
            'SUPABASE_SECRET_KEY': '',
        }
        with patch.dict(os.environ, test_env):
            try:
                from fastapi.testclient import TestClient
                from sqlalchemy import event
                from sqlmodel import Session, SQLModel, select
                api = importlib.import_module('app.main')
                models = importlib.import_module('app.models')
                passwords = importlib.import_module('app.security.password')
                security = importlib.import_module('app.security.session')
            except ImportError as error:
                print('의존성 설치 필요: python -m pip install -r backend/requirements.txt', file=sys.stderr)
                print(str(error), file=sys.stderr)
                return 2

            @event.listens_for(api.engine, 'connect')
            def enable_foreign_keys(connection, _record):
                cursor = connection.cursor()
                cursor.execute('PRAGMA foreign_keys=ON')
                cursor.close()

            class DidimTests(unittest.TestCase):
                """각 테스트마다 테이블과 가짜 계정을 새로 생성한다."""
                def setUp(self):
                    shutil.rmtree(work / 'uploads', ignore_errors=True)
                    SQLModel.metadata.drop_all(api.engine)
                    SQLModel.metadata.create_all(api.engine)
                    self.password = 'OnlyForTests!123'
                    hashed = passwords.hash_password(self.password)
                    with Session(api.engine) as session:
                        for username, active in [('teacher_a', True), ('teacher_b', True), ('inactive', False)]:
                            session.add(models.User(username=username, password_hash=hashed,
                                                    name='테스트 교사', is_active=active))
                        session.commit()
                    self.client = self.enterContext(TestClient(api.app))
                    # 외부 호출이 추가되더라도 데모 테스트에서 사용되면 실패한다.
                    self.enterContext(patch.object(api, 'Anthropic', side_effect=AssertionError('외부 AI 호출 발생')))
                    self.enterContext(patch.object(api, 'find_citations', side_effect=AssertionError('외부 법령 호출 발생')))

                def login(self, username='teacher_a', client=None):
                    client = client or self.client
                    response = client.post('/api/auth/login', json={'username': username, 'password': self.password})
                    self.assertEqual(response.status_code, 200)
                    return response

                def create_case(self, title='자동 테스트'):
                    response = self.client.post('/api/cases', json={'title': title})
                    self.assertEqual(response.status_code, 200)
                    return response.json()['id']

                def chat(self, case_id, content):
                    response = self.client.post(f'/api/cases/{case_id}/chat', json={'content': content})
                    self.assertEqual(response.status_code, 200)
                    self.assertIn('text/event-stream', response.headers['content-type'])
                    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
                    self.assertTrue(events, 'SSE 이벤트 없음')
                    self.assertFalse(any(item.get('type') == 'error' for item in events), 'SSE 오류 이벤트')
                    self.assertEqual(sum(item.get('type') == 'done' for item in events), 1)
                    self.assertEqual(events[-1]['type'], 'done')
                    answer = ''.join(item['text'] for item in events if item['type'] == 'delta').strip()
                    self.assertTrue(answer)
                    return events[-1]['assessment'], answer

                def upload(self, case_id):
                    content = b'didim-test-evidence\n'
                    response = self.client.post(f'/api/cases/{case_id}/attachments',
                                                files={'file': ('evidence.txt', content, 'text/plain')})
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()['size'], len(content))
                    return response.json()['id'], content

                def test_01_health(self):
                    response = self.client.get('/api/health')
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json(), {'ok': True, 'mode': 'demo', 'environment': 'test'})

                def test_02_unauthenticated_requests(self):
                    for method, path, body in [('GET', '/api/auth/me', None), ('GET', '/api/cases', None),
                                               ('POST', '/api/cases', {'title': 'test'}),
                                               ('POST', '/api/cases/1/chat', {'content': '엄'})]:
                        with self.subTest(path=path):
                            response = self.client.request(method, path, json=body)
                            self.assertEqual(response.status_code, 401)

                def test_03_invalid_login(self):
                    for username, password in [('teacher_a', 'wrong'), ('missing', self.password), ('inactive', self.password)]:
                        with self.subTest(username=username):
                            response = self.client.post('/api/auth/login', json={'username': username, 'password': password})
                            self.assertEqual(response.status_code, 401)

                def test_04_login_cookie_and_me(self):
                    response = self.login()
                    self.assertIn('HttpOnly', response.headers['set-cookie'])
                    self.assertIn('SameSite=lax', response.headers['set-cookie'])
                    me = self.client.get('/api/auth/me')
                    self.assertEqual(me.status_code, 200)
                    self.assertEqual(me.json()['username'], 'teacher_a')
                    self.assertNotIn('password_hash', me.json())

                def test_05_session_token_is_hashed(self):
                    self.login()
                    token = self.client.cookies.get(security.SESSION_COOKIE_NAME)
                    self.assertTrue(token)
                    with Session(api.engine) as session:
                        stored = session.exec(select(models.AuthSession)).one()
                        self.assertNotEqual(stored.token_hash, token)
                        self.assertEqual(stored.token_hash, security.hash_session_token(token))

                def test_06_logout_revokes_old_cookie(self):
                    self.login()
                    old_token = self.client.cookies.get(security.SESSION_COOKIE_NAME)
                    self.assertEqual(self.client.post('/api/auth/logout').status_code, 200)
                    self.assertEqual(self.client.get('/api/auth/me').status_code, 401)
                    self.client.cookies.set(security.SESSION_COOKIE_NAME, old_token)
                    self.assertEqual(self.client.get('/api/auth/me').status_code, 401)

                def test_07_expired_session(self):
                    self.login()
                    with Session(api.engine) as session:
                        record = session.exec(select(models.AuthSession)).one()
                        record.expires_at = '2000-01-01T00:00:00+00:00'
                        session.add(record)
                        session.commit()
                    self.assertEqual(self.client.get('/api/auth/me').status_code, 401)

                def test_08_create_list_greeting(self):
                    self.login()
                    case_id = self.create_case('  테스트 상담  ')
                    cases = self.client.get('/api/cases').json()
                    self.assertEqual(len(cases), 1)
                    self.assertEqual(cases[0]['id'], case_id)
                    self.assertEqual(cases[0]['title'], '테스트 상담')
                    messages = self.client.get(f'/api/cases/{case_id}/messages').json()
                    self.assertEqual(len(messages), 1)
                    self.assertEqual(messages[0]['role'], 'assistant')

                def test_09_blank_title_fallback(self):
                    self.login()
                    self.create_case('   ')
                    self.assertEqual(self.client.get('/api/cases').json()[0]['title'], '새 상담')

                def test_10_single_character_chat(self):
                    self.login()
                    case_id = self.create_case()
                    assessment, answer = self.chat(case_id, '엄')
                    messages = self.client.get(f'/api/cases/{case_id}/messages').json()
                    self.assertEqual(messages[-2]['content'], '엄')
                    self.assertEqual(messages[-1]['content'], answer)
                    stored = self.client.get(f'/api/cases/{case_id}/assessments').json()
                    self.assertEqual(len(stored), 1)
                    self.assertEqual(stored[0]['risk_score'], assessment['score'])
                    self.assertEqual(stored[0]['message_id'], messages[-1]['id'])

                def test_11_chat_validation(self):
                    self.login()
                    case_id = self.create_case()
                    for payload in [{'content': ''}, {'content': '가' * 8001}, {}, {'content': None}]:
                        with self.subTest(length=len(payload.get('content') or '')):
                            response = self.client.post(f'/api/cases/{case_id}/chat', json=payload)
                            self.assertEqual(response.status_code, 422)
                    self.assertEqual(len(self.client.get(f'/api/cases/{case_id}/messages').json()), 1)
                    self.assertEqual(self.client.get(f'/api/cases/{case_id}/assessments').json(), [])

                def test_12_demo_risk_levels(self):
                    self.login()
                    for text, level, score in [('안녕하세요', 'low', 15), ('매일 욕설', 'caution', 42),
                                                ('협박', 'danger', 60), ('칼로 폭행', 'emergency', 96)]:
                        with self.subTest(level=level):
                            case_id = self.create_case()
                            result, _ = self.chat(case_id, text)
                            self.assertEqual((result['level'], result['score']), (level, score))
                            self.assertTrue(result['actions'])

                def test_13_other_user_cannot_access_case(self):
                    self.login()
                    case_id = self.create_case()
                    attachment_id, _ = self.upload(case_id)
                    self.client.post('/api/auth/logout')
                    self.login('teacher_b')
                    self.assertEqual(self.client.get('/api/cases').json(), [])
                    prefix = f'/api/cases/{case_id}'
                    requests = [('GET', prefix + '/messages', {}), ('GET', prefix + '/assessments', {}),
                                ('GET', prefix + '/attachments', {}), ('POST', prefix + '/chat', {'json': {'content': '엄'}}),
                                ('POST', prefix + '/attachments', {'files': {'file': ('x.txt', b'x', 'text/plain')}}),
                                ('GET', prefix + f'/attachments/{attachment_id}/download', {}),
                                ('DELETE', prefix + f'/attachments/{attachment_id}', {}), ('DELETE', prefix, {})]
                    for method, path, kwargs in requests:
                        with self.subTest(method=method, path=path):
                            self.assertEqual(self.client.request(method, path, **kwargs).status_code, 404)
                    self.client.post('/api/auth/logout')
                    self.login()
                    self.assertEqual(len(self.client.get(prefix + '/messages').json()), 1)
                    self.assertEqual(len(self.client.get(prefix + '/attachments').json()), 1)

                def test_14_attachment_round_trip_delete(self):
                    self.login()
                    case_id = self.create_case()
                    attachment_id, content = self.upload(case_id)
                    prefix = f'/api/cases/{case_id}/attachments'
                    self.assertEqual(len(self.client.get(prefix).json()), 1)
                    response = self.client.get(f'{prefix}/{attachment_id}/download')
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.content, content)
                    self.assertEqual(self.client.delete(f'{prefix}/{attachment_id}').status_code, 204)
                    self.assertEqual(self.client.get(prefix).json(), [])
                    self.assertEqual(self.client.get(f'{prefix}/{attachment_id}/download').status_code, 404)

                def test_15_attachment_wrong_case(self):
                    self.login()
                    first, second = self.create_case(), self.create_case()
                    attachment_id, _ = self.upload(first)
                    prefix = f'/api/cases/{second}/attachments/{attachment_id}'
                    self.assertEqual(self.client.get(prefix + '/download').status_code, 404)
                    self.assertEqual(self.client.delete(prefix).status_code, 404)

                def test_16_oversized_upload_has_no_record_or_file(self):
                    self.login()
                    case_id = self.create_case()
                    response = self.client.post(f'/api/cases/{case_id}/attachments',
                                                files={'file': ('big.bin', b'x' * (1024 * 1024 + 1), 'application/octet-stream')})
                    self.assertEqual(response.status_code, 413)
                    self.assertEqual(self.client.get(f'/api/cases/{case_id}/attachments').json(), [])
                    self.assertEqual(list((api.UPLOAD_DIR / str(case_id)).glob('*')), [])

                def test_17_delete_case_cascades(self):
                    self.login()
                    case_id = self.create_case()
                    self.chat(case_id, '엄')
                    self.upload(case_id)
                    self.assertEqual(self.client.delete(f'/api/cases/{case_id}').status_code, 204)
                    self.assertEqual(self.client.get('/api/cases').json(), [])
                    self.assertEqual(self.client.get(f'/api/cases/{case_id}/messages').status_code, 404)
                    with Session(api.engine) as session:
                        for model in [models.Message, models.Assessment, models.Attachment]:
                            self.assertEqual(list(session.exec(select(model).where(model.case_id == case_id))), [])
                    self.assertEqual(list((api.UPLOAD_DIR / str(case_id)).glob('*')), [])

                def test_18_missing_case(self):
                    self.login()
                    for method, suffix, kwargs in [('GET', '/messages', {}), ('GET', '/assessments', {}),
                                                   ('GET', '/attachments', {}), ('DELETE', '', {}),
                                                   ('POST', '/chat', {'json': {'content': '엄'}})]:
                        with self.subTest(method=method, suffix=suffix):
                            self.assertEqual(self.client.request(method, '/api/cases/999999' + suffix, **kwargs).status_code, 404)

            try:
                suite = unittest.defaultTestLoader.loadTestsFromTestCase(DidimTests)
                result = unittest.TextTestRunner(verbosity=2).run(suite)
                return 0 if result.wasSuccessful() else 1
            finally:
                api.engine.dispose()


if __name__ == '__main__':
    raise SystemExit(main())
