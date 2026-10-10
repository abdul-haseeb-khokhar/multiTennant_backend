/**
 * The only purpose consent can be recorded for today (I11). Using customer conversations to train
 * our own model needs legal review (terms, data-processing agreement, lawful basis, de-identification)
 * BEFORE any training use. This module only records what a tenant owner chose; nothing in this
 * codebase reads that choice to export, copy or train on data, and nothing may until the review
 * is done. The default is OFF.
 */
export const MODEL_TRAINING_PURPOSE = 'model_training';
