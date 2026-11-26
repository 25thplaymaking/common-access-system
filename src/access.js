// Who may do what. Server admins (Administrator or Manage Server) are always
// staff; everyone else gets access through the roles picked in /setup.
const { PermissionFlagsBits } = require('discord.js');
const { getSetting } = require('./settings');

function roleIds(member) {
  if (!member) return [];
  if (member.roles?.cache) return [...member.roles.cache.keys()];
  if (Array.isArray(member.roles)) return member.roles; // raw API member
  return [];
}

function isServerAdmin(member, permissions = member?.permissions) {
  if (!permissions?.has) return false;
  return permissions.has(PermissionFlagsBits.Administrator) || permissions.has(PermissionFlagsBits.ManageGuild);
}

function hasAnyRole(member, wanted) {
  const have = new Set(roleIds(member));
  return (wanted || []).some((id) => have.has(id));
}

function isStaff(member, permissions) {
  return isServerAdmin(member, permissions) || hasAnyRole(member, getSetting('staff_roles'));
}

// kind: 'intake' | 'ticket'
function canHandleCase(member, kind, permissions) {
  if (isStaff(member, permissions)) return true;
  return hasAnyRole(member, getSetting(kind === 'intake' ? 'recruiter_roles' : 'support_roles'));
}

function canHostEvents(member, permissions) {
  return isStaff(member, permissions) || hasAnyRole(member, getSetting('host_roles'));
}

// Interaction helpers: i.memberPermissions is always set inside a server.
const staff = (i) => isStaff(i.member, i.memberPermissions);
const handler = (i, kind) => canHandleCase(i.member, kind, i.memberPermissions);
const host = (i) => canHostEvents(i.member, i.memberPermissions);
const admin = (i) => isServerAdmin(i.member, i.memberPermissions);

module.exports = { isServerAdmin, isStaff, canHandleCase, canHostEvents, hasAnyRole, roleIds, staff, handler, host, admin };
