import { officialExample } from '../helpers/contract.js';

/** Request bodies taken from the official examples, so the responses can be compared with them. */

/** The 422 example of POST /customers carries a full request without `name`. */
export function officialCustomerRequest(): Record<string, unknown> {
  const example = officialExample('POST', '/customers', '422') as { request: Record<string, unknown> };
  return { name: 'Tony Stark', document_type: 'CPF', ...structuredClone(example.request) };
}

/** Customer with the fields that the address/card examples show in their embedded customer. */
export const customerForEmbedding = {
  name: 'Tony Stark',
  email: 'tony@avengers.com',
  document: '93095135270',
  type: 'individual',
  phones: {
    home_phone: { country_code: '55', number: '000000000', area_code: '21' },
    mobile_phone: { country_code: '55', number: '000000000', area_code: '21' },
  },
  metadata: { company: 'Avengers' },
};

export const officialAddressRequest = {
  line_1: '375, Av. General Justo, Centro',
  line_2: '8º andar',
  zip_code: '20021130',
  city: 'Rio de Janeiro',
  state: 'RJ',
  country: 'BR',
  metadata: { id: 'my_address_id' },
};

/** "Request Crédito (Basico)" of docs/pagarme/reference/cartao-de-credito-1.md, with the card number as a parameter. */
export function officialOrderRequest(cardNumber = '4000000000000010') {
  return {
    items: [{ amount: 2990, description: 'Chaveiro do Tesseract', quantity: 1 }],
    customer: { name: 'Tony Stark', email: 'avengerstark@ligadajustica.com.br' },
    payments: [
      {
        payment_method: 'credit_card',
        credit_card: {
          recurrence_cycle: 'first',
          installments: 1,
          statement_descriptor: 'AVENGERS',
          card: {
            number: cardNumber,
            holder_name: 'Tony Stark',
            exp_month: 1,
            exp_year: 30,
            cvv: '3531',
            billing_address: {
              line_1: '10880, Malibu Point, Malibu Central',
              zip_code: '90265',
              city: 'Malibu',
              state: 'CA',
              country: 'US',
            },
          },
        },
      },
    ],
  };
}

/** Mastercard of the official card examples. */
export const officialCardRequest = {
  number: '5425019448107793',
  holder_name: 'Tony Stark',
  holder_document: '93095135270',
  exp_month: 1,
  exp_year: 30,
  cvv: '123',
  label: 'Sua bandeira',
  billing_address: {
    line_1: '375, Av. General Osorio, Centro',
    line_2: '7º Andar',
    zip_code: '220000111',
    city: 'Rio de Janeiro',
    state: 'RJ',
    country: 'BR',
  },
};
