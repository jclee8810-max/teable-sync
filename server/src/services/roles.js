export const ROLES = {
  OWNER: 'owner',
  SUPER_ADMIN: 'super_admin',
  USER: 'user',
};

export function isOwner(user) {
  return user?.role === ROLES.OWNER;
}

export function isAdmin(user) {
  return user?.role === ROLES.OWNER || user?.role === ROLES.SUPER_ADMIN;
}

export function roleLabel(role) {
  if (role === ROLES.OWNER) return '系统所有者';
  if (role === ROLES.SUPER_ADMIN) return '管理员';
  return '普通用户';
}

export function ensureOwner(users = []) {
  if (!Array.isArray(users) || users.length === 0) return users;
  if (users.some((user) => user.role === ROLES.OWNER)) return users;
  const candidates = users
    .filter((user) => user.role === ROLES.SUPER_ADMIN)
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  const owner = candidates[0] || [...users].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))[0];
  if (owner) owner.role = ROLES.OWNER;
  return users;
}
