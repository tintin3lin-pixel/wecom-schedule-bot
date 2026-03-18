-- 日程事件表
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  eventType TEXT NOT NULL DEFAULT '其他',
  participants TEXT NOT NULL DEFAULT '',
  projectName TEXT DEFAULT '',
  startTime INTEGER NOT NULL,
  endTime INTEGER NOT NULL,
  location TEXT DEFAULT '',
  contactName TEXT DEFAULT '',
  contactTitle TEXT DEFAULT '',
  contactOrg TEXT DEFAULT '',
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  rawMessage TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_events_startTime ON events(startTime);
CREATE INDEX IF NOT EXISTS idx_events_eventType ON events(eventType);
