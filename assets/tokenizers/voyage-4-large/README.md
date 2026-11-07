# Voyage query tokenizer

Vendored from the publisher's `MongoDB/voyage-4-large` repository at immutable revision
`bb931c2635a93efe400c24741363d8ff61d7bb32` on 2026-11-06. Voyage's documented
`voyageai/voyage-4-large` Hugging Face location redirects to this repository.
The publisher's model card specifies Apache-2.0; the license is included here.
These are tokenizer assets, not model weights or private corpus data.

| File | SHA-256 |
| --- | --- |
| tokenizer.json | c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539 |
| tokenizer_config.json | 58c4abbc36eeccd8b3c8453f262225e8f2803855c88790760b618f4cd9e43be9 |

Sources:

- [Pinned publisher files](https://huggingface.co/MongoDB/voyage-4-large/tree/bb931c2635a93efe400c24741363d8ff61d7bb32)
- [Voyage tokenization guide](https://docs.voyageai.com/docs/tokenization)
- [Voyage embeddings contract and input-type prefixes](https://docs.voyageai.com/reference/embeddings-api)
- [Voyage Python SDK tokenizer implementation](https://github.com/voyage-ai/voyageai-python/blob/9aca465efd0011c478031f6d584b70a3a4393a7c/voyageai/_base.py#L149-L192)
- [Hugging Face JavaScript implementation](https://github.com/huggingface/tokenizers.js)

`createVoyageQueryTokenCounter` loads and verifies both assets once during prepare;
it makes no downloads or provider calls. Its count includes the documented
`input_type=query` prefix followed by the exact serialized query. The SDK's
`count_tokens` counts raw input and does not prepend this prefix. This is a local
preflight count, not reported billable usage. The hosted model revision is not
immutable; provider/model changes require checking this contract again.

The runtime is pinned to `@huggingface/tokenizers@0.2.0` (Apache-2.0, pure JS).
The tokenizer uses NFC normalization, BPE, Split/ByteLevel pretokenization and
ByteLevel postprocessing; it has no truncation or padding. Golden fixtures in
`tests/fixtures/voyage-tokenizer-golden.json` contain exact IDs from canonical
Python `tokenizers==0.22.2` (Rust), using `Tokenizer.from_file`, `no_truncation`,
`no_padding`, and default `add_special_tokens=True`. Tests compare raw and
prefix-inclusive IDs for 20 fictional inputs spanning Unicode, special tokens,
whitespace and serialized conversation labels. During implementation, another
500 seeded mixed-Unicode strings also matched exactly. These checks establish
parity for those fixtures, not a proof over arbitrary text or future runtimes.
