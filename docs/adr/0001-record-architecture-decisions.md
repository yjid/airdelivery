# 1. Record architecture decisions

Date: 2025

## Status

Accepted

## Context

The project grew organically. Several decisions shaped it strongly — why the
server relays SDP but never file data, why flights hold exactly two peers, why
bulk channels are partially reliable — and none of them were written down. The
reasoning was reconstructed from commit history, which is slow and lossy.

## Decision

Record decisions that are hard to reverse, surprising on first reading, or the
kind of thing someone would otherwise "fix" without knowing why.

## Consequences

A contributor proposing a change that contradicts a decision should either
supersede the ADR or explain why the constraint no longer holds. That is the
point: disagreement becomes explicit instead of silent.
