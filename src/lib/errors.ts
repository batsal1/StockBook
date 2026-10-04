export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'error', public details?: unknown) {
    super(message);
  }
}
export const notFound = (what: string) => new AppError(404, `${what} not found`, 'not_found');
export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, 'bad_request', details);
export const forbidden = (msg = 'You do not have permission to do this') => new AppError(403, msg, 'forbidden');
export const conflict = (msg: string) => new AppError(409, msg, 'conflict');
