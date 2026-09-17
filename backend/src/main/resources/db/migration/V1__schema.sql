CREATE TABLE learners (
 id VARCHAR(36) PRIMARY KEY,
 token_hash VARCHAR(64) NOT NULL UNIQUE,
 created_at VARCHAR(40) NOT NULL
);
CREATE TABLE tags (id VARCHAR(40) PRIMARY KEY, name VARCHAR(100) NOT NULL);
INSERT INTO tags(id,name) VALUES
 ('os-basics','운영체제 개요'),('process','프로세스'),('thread','스레드'),
 ('scheduling','CPU 스케줄링'),('synchronization','동기화'),('deadlock','교착 상태'),
 ('memory','메모리 관리'),('virtual-memory','가상 메모리'),('filesystem','파일 시스템'),('io','입출력');
CREATE TABLE documents (
 id VARCHAR(36) PRIMARY KEY, learner_id VARCHAR(36) NOT NULL REFERENCES learners(id),
 name VARCHAR(255) NOT NULL, page_count INTEGER NOT NULL, created_at VARCHAR(40) NOT NULL
);
CREATE TABLE document_pages (
 document_id VARCHAR(36) NOT NULL REFERENCES documents(id), page_number INTEGER NOT NULL,
 content TEXT NOT NULL, PRIMARY KEY(document_id,page_number)
);
CREATE TABLE document_chunks (
 document_id VARCHAR(36) NOT NULL REFERENCES documents(id), chunk_index INTEGER NOT NULL,
 start_page INTEGER NOT NULL, end_page INTEGER NOT NULL, content TEXT NOT NULL,
 PRIMARY KEY(document_id,chunk_index)
);
CREATE TABLE jobs (
 id VARCHAR(36) PRIMARY KEY, learner_id VARCHAR(36) NOT NULL REFERENCES learners(id),
 document_id VARCHAR(36) REFERENCES documents(id), mode VARCHAR(10) NOT NULL,
 status VARCHAR(15) NOT NULL, total_chunks INTEGER NOT NULL, completed_chunks INTEGER NOT NULL DEFAULT 0,
 failed_chunks INTEGER NOT NULL DEFAULT 0, question_count INTEGER NOT NULL DEFAULT 0,
 error VARCHAR(500), created_at VARCHAR(40) NOT NULL
);
CREATE TABLE job_chunks (
 job_id VARCHAR(36) NOT NULL REFERENCES jobs(id), chunk_index INTEGER NOT NULL,
 status VARCHAR(15) NOT NULL, error VARCHAR(500), attempts INTEGER NOT NULL DEFAULT 0,
 parse_attempts INTEGER NOT NULL DEFAULT 0, parse_success BOOLEAN NOT NULL DEFAULT FALSE,
 duration_ms BIGINT NOT NULL DEFAULT 0, input_tokens BIGINT NOT NULL DEFAULT 0,
 output_tokens BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(job_id,chunk_index)
);
CREATE TABLE questions (
 id VARCHAR(36) PRIMARY KEY, learner_id VARCHAR(36) NOT NULL REFERENCES learners(id),
 job_id VARCHAR(36) NOT NULL REFERENCES jobs(id), chunk_index INTEGER NOT NULL,
 document_id VARCHAR(36) REFERENCES documents(id), text TEXT NOT NULL, options TEXT NOT NULL,
 correct_index INTEGER NOT NULL CHECK(correct_index BETWEEN 0 AND 3), tag_id VARCHAR(40) NOT NULL REFERENCES tags(id),
 difficulty VARCHAR(10) NOT NULL, explanation TEXT NOT NULL, source_start_page INTEGER, source_end_page INTEGER,
 mode VARCHAR(10) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 box INTEGER NOT NULL DEFAULT 0 CHECK(box BETWEEN 0 AND 5), due_date VARCHAR(10), latest_correct BOOLEAN,
 deleted BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE attempts (
 id VARCHAR(36) PRIMARY KEY, learner_id VARCHAR(36) NOT NULL REFERENCES learners(id),
 question_id VARCHAR(36) NOT NULL REFERENCES questions(id), idempotency_key VARCHAR(36) NOT NULL,
 selected_index INTEGER NOT NULL, question_version INTEGER NOT NULL, correct BOOLEAN NOT NULL,
 result TEXT NOT NULL, created_at VARCHAR(40) NOT NULL,
 UNIQUE(learner_id,idempotency_key)
);
CREATE INDEX idx_questions_owner ON questions(learner_id,deleted);
CREATE INDEX idx_questions_due ON questions(learner_id,due_date);
CREATE INDEX idx_attempts_question ON attempts(question_id);
CREATE INDEX idx_jobs_owner ON jobs(learner_id,created_at);
CREATE INDEX idx_documents_owner ON documents(learner_id,created_at);
