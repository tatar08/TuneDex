import { IdpError } from '../src/account/idp-users';
import { afterFailure, jobErrorCode, MAX_ATTEMPTS } from '../src/jobs/retry-policy';

describe('shared job retry policy (Doc 17: exponential, capped at 5, then dead letter)', () => {
  it('backs off 1, 5, 15, 60 minutes and dead-letters on the 5th failure', () => {
    const steps = [0, 1, 2, 3, 4].map((before) => afterFailure(before));
    expect(steps.map((s) => s.attempts)).toEqual([1, 2, 3, 4, 5]);
    expect(steps.map((s) => s.retryInSeconds)).toEqual([60, 300, 900, 3600, null]);
    expect(MAX_ATTEMPTS).toBe(5);
    expect(afterFailure(7).retryInSeconds).toBeNull();
  });

  it('keeps only a code from an error, never its message', () => {
    expect(jobErrorCode(new IdpError('delete', 503))).toBe('IDP_DELETE_FAILED');
    expect(jobErrorCode(Object.assign(new Error('duplicate key value (email)=(a@b.test)'), { code: '23505' }))).toBe('DB_23505');
    expect(jobErrorCode(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' }))).toBe('SYS_ECONNREFUSED');
    expect(jobErrorCode(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('TIMEOUT');
    expect(jobErrorCode(new Error('token=abc'))).toBe('INTERNAL_ERROR');
    expect(jobErrorCode(null)).toBe('INTERNAL_ERROR');
  });
});
