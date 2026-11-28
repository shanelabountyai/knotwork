// The two classifiers behind the seam in classifier.ts (D-135). Local only: `none` does nothing, and `stub` reads
// grey-level statistics of the processed thumbnail (uploads/process.ts greyStats, on this server). No model, no
// network, no new dependency (tests/knotwork/structure.test.ts scans this file's imports).
import { greyStats, type Processed } from '../uploads/process';
import { stubAdvice, type Advice, type ClassifierName, type PhotoClassifier } from './classifier';

const none: PhotoClassifier = { name: 'none', classify: async () => null };

const stub: PhotoClassifier = {
  name: 'stub',
  classify: async (image: Processed): Promise<Advice> => stubAdvice(await greyStats(image)),
};

const BY_NAME: Record<ClassifierName, PhotoClassifier> = { none, stub };

export const classifierFor = (name: ClassifierName): PhotoClassifier => BY_NAME[name];
