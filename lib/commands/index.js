// lib/commands/index.js — 命令注册表

module.exports = {
  search: require('./search'),
  get: require('./get'),
  replies: require('./replies'),
  my: require('./my'),
  post: require('./post'),
  like: require('./like'),
  'delete-comment': require('./delete-comment'),
  download: require('./download'),
  analyze: require('./analyze'),
  suggest: require('./suggest'),
  dashboard: require('./dashboard'),
  log: require('./log'),
  profile: require('./profile'),
};
